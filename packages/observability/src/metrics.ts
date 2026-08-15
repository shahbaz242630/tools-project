/**
 * What the platform can tell you about itself while it is running.
 *
 * Until this module there was no answer to "how slow is it", "how many requests
 * failed" or "is the queue draining" — the logs record what happened to one
 * request, and nothing aggregated. That is the difference between being able to
 * debug an incident and being able to *notice* one.
 *
 * **An interface with a production adapter and a fake, like every other
 * provider** (BRD §5.1). Nothing outside this file imports `prom-client`, so the
 * metric names, the label vocabulary and the bucket boundaries live in one
 * place — and the day a different backend is wanted, it is one adapter.
 *
 * **The interface is domain-shaped rather than a generic `counter(name)`.** A
 * generic API invites two failures this one cannot have: metric names that drift
 * apart across call sites, and unbounded label cardinality. A metrics series is
 * created per distinct label combination and kept in memory — a label carrying a
 * listing id is a memory leak that grows with the business, and a label carrying
 * a postcode is personal data in a system with none of §10.1's retention rules.
 */

import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import type { SearchRadiusMiles } from '@platform/contracts';
import type { Logger } from './logger.js';

/**
 * How long a request took, and what happened to it.
 *
 * `route` is a **template** — `/listings/:id`, never `/listings/8fe74923-…`.
 * `normaliseRoute` below enforces that rather than trusting callers, because
 * "remember to pass the template" is exactly the rule that gets forgotten by the
 * one call site that matters.
 */
export interface HttpRequestSample {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface DatabaseQuerySample {
  /** The operation, not the SQL: `listing.findMany`, never a rendered query. */
  readonly operation: string;
  readonly durationMs: number;
  readonly failed?: boolean;
}

export interface QueueJobSample {
  readonly queue: string;
  readonly jobName: string;
  readonly durationMs: number;
  readonly outcome: 'completed' | 'failed';
}

/**
 * What a search *did* — the four things a status code cannot tell you apart
 * (slice 3.1f).
 *
 * - **`found`** — at least one listing came back.
 * - **`empty`** — we searched and there is nothing there. **The single most
 *   valuable number this file records**: BRD §17 names low inventory density as
 *   the dominant failure mode of local marketplaces, and until this existed we
 *   could not say what fraction of searches find nothing.
 * - **`beyond_end`** — a page past the last one. Kept apart from `empty`
 *   deliberately: it is somebody walking off the end of a result set that *did*
 *   have listings, so counting it as a zero-result search would corrupt the one
 *   number above with a navigation artefact.
 * - **`unplaceable`** — we could not search from there at all, because the
 *   origin did not geocode. It is served as an empty page (§8.4, slice 3.1a) and
 *   **that is exactly why it needs its own counter**: without one, our own
 *   geocoding provider going down is indistinguishable from a quiet area.
 */
export type ListingSearchOutcome = 'found' | 'empty' | 'beyond_end' | 'unplaceable';

export interface ListingSearchSample {
  /**
   * How far the search looked.
   *
   * **Typed as the contract's closed union rather than `number`, and that is the
   * cardinality control** — not documentation. A metrics series exists per
   * distinct label combination, so a free `number` here is one series per value
   * a caller can invent. Five values times four outcomes is twenty series, and
   * the compiler is what holds it there.
   *
   * It is worth recording at all because the cost is not flat: slice 3.1c
   * measured 12.1 ms at five miles and 111.8 ms at a hundred, so an aggregate
   * timing with no radius on it averages two different questions together.
   */
  readonly radiusMiles: SearchRadiusMiles;
  readonly outcome: ListingSearchOutcome;
  /**
   * Whether the searcher narrowed to a category (slice 3.2a).
   *
   * **A boolean, and never the category itself — this is the cardinality rule
   * doing the work it exists for.** Radius and outcome are closed unions the
   * compiler holds at twenty series. A category slug is *configuration*: an
   * administrator adds one through a form, with no deploy and nobody watching
   * this file, so a `category` label is a series count the business grows. It
   * would also be the first label in this system whose values are not fixed at
   * compile time, in a store that has none of §10.1's retention or erasure
   * rules.
   *
   * What is worth knowing is not *which* category was filtered but **whether
   * filtering is what emptied the page** — BRD §17's zero-result rate is the
   * number this file exists to answer, and a filter is a new way to make a
   * search return nothing. Two values, so the twenty series become forty and
   * `sum(listing_searches_total{outcome="empty"}) / sum(listing_searches_total)`
   * keeps working unchanged.
   */
  readonly filtered: boolean;
}

/**
 * How the postcode geocoder behaved (slice 3.1f).
 *
 * The three outcomes are the ones `geocodeQuietly` already distinguishes and
 * then deliberately collapses to one null for its callers. Collapsing is right
 * for the caller — two failure paths ending in the same place is how one of them
 * gets handled wrongly — but it means the difference existed nowhere at all.
 *
 * - **`found`** — the provider answered with a point.
 * - **`unknown`** — the provider answered and does not recognise the postcode.
 *   Permanent, and ordinary: new postcodes are issued continuously.
 * - **`unavailable`** — the question never got an answer. A timeout, a network
 *   failure, an unreadable body. **This is the one to alert on**, and until now
 *   a provider outage was visible only as a warning line in the logs.
 */
export type GeocodeOutcome = 'found' | 'unknown' | 'unavailable';

export interface GeocodeSample {
  readonly outcome: GeocodeOutcome;
  /**
   * How long the provider took, including a call that ended in a timeout.
   *
   * The timeout is the case worth watching — somebody is waiting on it — so the
   * duration is recorded for every outcome rather than only for the happy one.
   * A failure path with no timing is one where "it broke" and "it hung for two
   * and a half seconds and then broke" look the same.
   */
  readonly durationMs: number;
}

/**
 * The exposition content type, as a constant.
 *
 * `prom-client` carries this on its registry, which is the authority — but a
 * Nest `@Header()` decorator needs a compile-time value, so the constant has to
 * exist independently. `metrics.test.ts` asserts the two agree, so an upgrade
 * that changed the format version fails a test rather than silently serving a
 * scraper the wrong header.
 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface Metrics {
  recordHttpRequest(sample: HttpRequestSample): void;
  recordDatabaseQuery(sample: DatabaseQuerySample): void;
  recordQueueJob(sample: QueueJobSample): void;
  /**
   * One public listing search, and what it found (slice 3.1f).
   *
   * **Deliberately carries no timing.** The HTTP histogram already times this
   * route by template, and a second duration for the same span is two numbers
   * that can disagree about one thing. What was missing was never how long a
   * search took — it was what it did.
   */
  recordListingSearch(sample: ListingSearchSample): void;
  /**
   * One call to the postcode geocoder (slice 3.1f).
   *
   * **Recorded once per provider call, wherever it was made from** — saving a
   * listing and running a search both reach it through the same helper, and
   * there is no `caller` label because the remedy for a sick geocoder is the
   * same either way. The route histogram already says which path was slow.
   */
  recordGeocode(sample: GeocodeSample): void;
  /** The exposition text Prometheus scrapes. */
  render(): Promise<string>;
  /** The content type that text must be served with. */
  readonly contentType: string;
}

/**
 * A route template, whatever the caller actually passed.
 *
 * **This is a privacy control as much as a cardinality one**, which is why it
 * collapses rather than trusting. A UUID in a label is a listing or a user, kept
 * in process memory and exported to a scraper — a place with none of §10.1's
 * retention or erasure guarantees. Deletion cannot reach it, and nobody would
 * think to look.
 *
 * Collapsing also bounds the series count: one series per route rather than one
 * per resource, which is the difference between a few hundred and one per row in
 * the database.
 *
 * Deliberately aggressive. A false positive costs a slightly coarser metric; a
 * false negative costs an unbounded series and an identifier where none belongs.
 */
export function normaliseRoute(route: string): string {
  if (route === '') return 'unknown';

  return route
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      // Already a template.
      if (segment.startsWith(':')) return segment;
      // A UUID, in any of the shapes an id reaches a URL in.
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
      ) {
        return ':id';
      }
      // Anything mostly digits: a numeric id, a year, a page number.
      if (/^\d+$/.test(segment)) return ':id';
      // A long opaque token — Clerk ids, session ids, anything base-ish.
      if (segment.length > 24 && !segment.includes('.')) return ':id';
      return segment;
    })
    .join('/');
}

/**
 * Status **class**, not status code.
 *
 * `2xx`/`4xx`/`5xx` answers every question a dashboard asks — is it working, are
 * callers wrong, are we wrong — with three series instead of dozens. The exact
 * code is in the log line for the request, where it belongs and where it is
 * attached to the thing that produced it.
 */
function statusClass(statusCode: number): string {
  if (statusCode < 200) return '1xx';
  if (statusCode < 300) return '2xx';
  if (statusCode < 400) return '3xx';
  if (statusCode < 500) return '4xx';
  return '5xx';
}

/**
 * Buckets in **seconds**, which is what Prometheus convention expects.
 *
 * Chosen for what this platform actually does rather than copied: the fast end
 * matters because most reads are a single indexed query, and the slow end runs
 * to ten seconds because a listing save calls a third-party geocoder with a
 * 2.5 s timeout and a person is waiting on it. Buckets that stopped at one
 * second would put every geocoding request in `+Inf` and tell us nothing about
 * the case we most want to watch.
 */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Tighter, because a query that takes a second is already a problem. */
const DATABASE_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

/** Wider: a job is allowed to be slow, and the tail is the interesting part. */
const QUEUE_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60];

/**
 * Built around **one number: the geocoder's 2500 ms timeout**.
 *
 * `2.5` and `5` are both here on purpose. A call that times out takes slightly
 * *more* than 2.5 s, so it lands in `le=5` — which makes the gap between those
 * two buckets the timeout's signature, readable without knowing anything about
 * how the adapter is written. Buckets that stopped at 1 s would put every
 * healthy call and every timeout together in `+Inf`.
 */
const GEOCODE_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5];

/**
 * The real thing.
 *
 * **A private `Registry` rather than the global default**, so two of these in one
 * process — a test suite, say — cannot collide on metric names, and so nothing
 * registered by a dependency leaks into our exposition without us choosing it.
 */
export function createPrometheusMetrics(options: {
  readonly service: string;
}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.service });

  /*
   * Node's own numbers: event-loop lag, heap, handles, GC pauses.
   *
   * These are the ones that answer "does it hold up under load" — a service
   * that is slow because the event loop is blocked looks identical, from
   * request timings alone, to one that is slow because Postgres is. They cost
   * almost nothing and cannot be reconstructed after the fact.
   */
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'How long HTTP requests took, by route template and status class.',
    labelNames: ['method', 'route', 'status'],
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });

  const databaseDuration = new Histogram({
    name: 'database_query_duration_seconds',
    help: 'How long database operations took, by operation.',
    labelNames: ['operation', 'outcome'],
    buckets: DATABASE_BUCKETS,
    registers: [registry],
  });

  const queueDuration = new Histogram({
    name: 'queue_job_duration_seconds',
    help: 'How long queue jobs took, by queue and job name.',
    labelNames: ['queue', 'job', 'outcome'],
    buckets: QUEUE_BUCKETS,
    registers: [registry],
  });

  /*
   * **A counter rather than a histogram**, which is the one place these two
   * additions differ in shape. There is nothing to time here that the HTTP
   * histogram is not already timing, so what is wanted is a count per outcome —
   * and `rate(listing_searches_total{outcome="empty"}[…]) / rate(…)` is the
   * zero-result rate BRD §17 asks for, in one expression.
   */
  const listingSearches = new Counter({
    name: 'listing_searches_total',
    help: 'Public listing searches, by radius, category filtering and what the searcher got back.',
    labelNames: ['radius', 'outcome', 'filtered'],
    registers: [registry],
  });

  const geocodeDuration = new Histogram({
    name: 'geocode_duration_seconds',
    help: 'How long postcode geocoding took, and how it ended.',
    labelNames: ['outcome'],
    buckets: GEOCODE_BUCKETS,
    registers: [registry],
  });

  return {
    recordHttpRequest(sample) {
      httpDuration.observe(
        {
          method: sample.method.toUpperCase(),
          route: normaliseRoute(sample.route),
          status: statusClass(sample.statusCode),
        },
        // Histograms carry their own count, so there is no separate counter to
        // keep in step — `_count` on this metric *is* the request total.
        sample.durationMs / 1000,
      );
    },

    recordDatabaseQuery(sample) {
      databaseDuration.observe(
        {
          operation: sample.operation,
          outcome: sample.failed === true ? 'failed' : 'ok',
        },
        sample.durationMs / 1000,
      );
    },

    recordQueueJob(sample) {
      queueDuration.observe(
        { queue: sample.queue, job: sample.jobName, outcome: sample.outcome },
        sample.durationMs / 1000,
      );
    },

    recordListingSearch(sample) {
      listingSearches.inc({
        // A label value is a string in the exposition either way; converting it
        // here rather than at the call site keeps the caller's type the closed
        // numeric union, which is what bounds this to forty series.
        radius: String(sample.radiusMiles),
        outcome: sample.outcome,
        // Likewise a boolean at the call site, so the only two values this can
        // ever take are the two the type allows.
        filtered: String(sample.filtered),
      });
    },

    recordGeocode(sample) {
      geocodeDuration.observe({ outcome: sample.outcome }, sample.durationMs / 1000);
    },

    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

/**
 * Metrics turned off.
 *
 * **Records nothing and renders an empty exposition**, rather than throwing or
 * being absent. The rule the whole codebase follows: a dependency that is not
 * configured degrades to doing nothing useful, never to taking the caller down
 * with it. `createNoopErrorTracker` makes the same trade one file over.
 *
 * The empty body is still valid exposition text, so a scraper pointed at a
 * service with metrics disabled sees a live endpoint with no series — which is
 * a much clearer signal than a connection refused.
 */
export function createNoopMetrics(logger?: Logger): Metrics {
  logger?.debug('metrics are disabled', { reason: 'no metrics adapter configured' });

  return {
    recordHttpRequest() {
      /* deliberately nothing */
    },
    recordDatabaseQuery() {
      /* deliberately nothing */
    },
    recordQueueJob() {
      /* deliberately nothing */
    },
    recordListingSearch() {
      /* deliberately nothing */
    },
    recordGeocode() {
      /* deliberately nothing */
    },
    render: () => Promise.resolve(''),
    contentType: PROMETHEUS_CONTENT_TYPE,
  };
}
