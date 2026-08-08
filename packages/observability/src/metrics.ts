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

import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
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
    render: () => Promise.resolve(''),
    contentType: PROMETHEUS_CONTENT_TYPE,
  };
}
