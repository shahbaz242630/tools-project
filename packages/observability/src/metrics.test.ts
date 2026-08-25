import { describe, expect, it } from 'vitest';
import {
  PROMETHEUS_CONTENT_TYPE,
  createNoopMetrics,
  createPrometheusMetrics,
  normaliseRoute,
} from './metrics.js';

const metrics = () => createPrometheusMetrics({ service: 'api' });

describe('normaliseRoute', () => {
  /**
   * The privacy half. A UUID in a label is a listing or a user, held in process
   * memory and handed to a scraper — somewhere deletion cannot reach and §10.1's
   * retention rules do not apply.
   */
  it('collapses a UUID', () => {
    expect(normaliseRoute('/listings/8fe74923-e424-421c-b5a2-590280af0fae')).toBe(
      '/listings/:id',
    );
  });

  it('collapses a UUID in upper case', () => {
    expect(normaliseRoute('/listings/8FE74923-E424-421C-B5A2-590280AF0FAE')).toBe(
      '/listings/:id',
    );
  });

  it('collapses a numeric id', () => {
    expect(normaliseRoute('/users/12345/profile')).toBe('/users/:id/profile');
  });

  it('collapses a long opaque token, such as a provider id', () => {
    expect(normaliseRoute('/webhooks/user_2abcdefghijklmnopqrstuvwxyz012')).toBe(
      '/webhooks/:id',
    );
  });

  it('collapses more than one segment', () => {
    expect(
      normaliseRoute('/listings/8fe74923-e424-421c-b5a2-590280af0fae/publication'),
    ).toBe('/listings/:id/publication');
  });

  it('leaves a template alone', () => {
    expect(normaliseRoute('/listings/:id/publication')).toBe(
      '/listings/:id/publication',
    );
  });

  it('leaves ordinary path segments alone', () => {
    expect(normaliseRoute('/admin/categories')).toBe('/admin/categories');
    expect(normaliseRoute('/health')).toBe('/health');
  });

  /**
   * A slug is not an identifier — it is chosen configuration, there are a
   * handful of them, and losing it would make the category routes unreadable on
   * a dashboard.
   */
  it('leaves a category slug alone', () => {
    expect(normaliseRoute('/admin/categories/outdoor-gardening')).toBe(
      '/admin/categories/outdoor-gardening',
    );
  });

  it('answers "unknown" for an empty route rather than an empty label', () => {
    expect(normaliseRoute('')).toBe('unknown');
  });
});

describe('http metrics', () => {
  it('records a request as a histogram observation', async () => {
    const m = metrics();
    m.recordHttpRequest({
      method: 'get',
      route: '/listings/:id',
      statusCode: 200,
      durationMs: 42,
    });

    const text = await m.render();
    expect(text).toContain('http_request_duration_seconds_count');
    expect(text).toContain('route="/listings/:id"');
    // Upper-cased, so `get` and `GET` are one series rather than two.
    expect(text).toContain('method="GET"');
  });

  /**
   * Three series instead of dozens. The exact code is on the request's log line,
   * attached to the thing that produced it.
   */
  it('labels by status class, not status code', async () => {
    const m = metrics();
    m.recordHttpRequest({ method: 'GET', route: '/a', statusCode: 404, durationMs: 1 });
    m.recordHttpRequest({ method: 'GET', route: '/a', statusCode: 422, durationMs: 1 });

    const text = await m.render();
    expect(text).toContain('status="4xx"');
    expect(text).not.toContain('status="404"');
    expect(text).not.toContain('status="422"');
  });

  /**
   * The guarantee the whole module exists for: an id cannot reach the
   * exposition even if a caller passes a raw path.
   */
  it('never exports an identifier, even when handed a raw path', async () => {
    const m = metrics();
    m.recordHttpRequest({
      method: 'GET',
      route: '/listings/8fe74923-e424-421c-b5a2-590280af0fae',
      statusCode: 200,
      durationMs: 1,
    });

    expect(await m.render()).not.toContain('8fe74923');
  });

  it('converts milliseconds to the seconds Prometheus expects', async () => {
    const m = metrics();
    m.recordHttpRequest({
      method: 'GET',
      route: '/a',
      statusCode: 200,
      durationMs: 250,
    });

    const text = await m.render();
    // 0.25s falls in the 0.25 bucket and every wider one, and not in 0.1.
    expect(text).toMatch(/http_request_duration_seconds_sum\{[^}]*\}\s+0\.25/);
  });
});

describe('database and queue metrics', () => {
  it('records a query by operation, never by SQL', async () => {
    const m = metrics();
    m.recordDatabaseQuery({ operation: 'listing.findMany', durationMs: 8 });

    const text = await m.render();
    expect(text).toContain('operation="listing.findMany"');
    expect(text).toContain('outcome="ok"');
  });

  it('distinguishes a failed query', async () => {
    const m = metrics();
    m.recordDatabaseQuery({ operation: 'listing.create', durationMs: 3, failed: true });

    expect(await m.render()).toContain('outcome="failed"');
  });

  it('records a queue job with its outcome', async () => {
    const m = metrics();
    m.recordQueueJob({
      // A real job name, not an invented one: `MetricJobName` is a closed union from
      // slice H6, because these become Prometheus labels and a `string` here is how a
      // series-per-unknown-name gets minted.
      queue: 'maintenance',
      jobName: 'expire-requests',
      durationMs: 1_200,
      outcome: 'completed',
    });

    const text = await m.render();
    expect(text).toContain('queue="maintenance"');
    expect(text).toContain('job="expire-requests"');
    expect(text).toContain('outcome="completed"');
  });
});

/** The label names on the first series line of `name`, sorted. */
function labelsOf(text: string, name: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`)) ?? '';
  const inside = line.slice(line.indexOf('{') + 1, line.indexOf('}'));

  return inside
    .split(',')
    .map((pair) => pair.split('=')[0] ?? '')
    .sort();
}

/** The value at the end of the first line of `name` matching `contains`. */
function valueOf(text: string, name: string, contains: string): string {
  const line =
    text
      .split('\n')
      .find((l) => l.startsWith(`${name}{`) && l.includes(contains))
      ?.trim() ?? '';

  return line.slice(line.lastIndexOf(' ') + 1);
}

/**
 * What a search did (slice 3.1f).
 *
 * The reason this metric exists: H1 already times every request to
 * `/public/listings` by route template and status class, so a 200 with
 * twenty-four results and a 200 with nothing were already both counted — and
 * were indistinguishable.
 */
describe('recording a listing search', () => {
  it('counts a search by radius and outcome', async () => {
    const m = metrics();
    m.recordListingSearch({
      radiusMiles: 20,
      outcome: 'found',
      filtered: false,
      keyworded: false,
    });

    const text = await m.render();
    expect(text).toContain('listing_searches_total');
    expect(text).toContain('radius="20"');
    expect(text).toContain('outcome="found"');
  });

  it('keeps the four outcomes apart, which is the whole point', async () => {
    const m = metrics();
    m.recordListingSearch({
      radiusMiles: 5,
      outcome: 'found',
      filtered: false,
      keyworded: false,
    });
    m.recordListingSearch({
      radiusMiles: 5,
      outcome: 'empty',
      filtered: false,
      keyworded: false,
    });
    m.recordListingSearch({
      radiusMiles: 5,
      outcome: 'beyond_end',
      filtered: false,
      keyworded: false,
    });
    m.recordListingSearch({
      radiusMiles: 5,
      outcome: 'unplaceable',
      filtered: false,
      keyworded: false,
    });

    const text = await m.render();
    for (const outcome of ['found', 'empty', 'beyond_end', 'unplaceable']) {
      expect(text).toContain(`outcome="${outcome}"`);
    }
  });

  it('accumulates rather than replacing, so a rate can be taken', async () => {
    const m = metrics();
    for (let i = 0; i < 3; i++) {
      m.recordListingSearch({
        radiusMiles: 100,
        outcome: 'empty',
        filtered: false,
        keyworded: false,
      });
    }

    expect(valueOf(await m.render(), 'listing_searches_total', 'radius="100"')).toBe(
      '3',
    );
  });

  /*
   * **Whether a category was chosen, never which one** (slice 3.2a). The
   * distinction is the whole reason this label is a boolean: a slug is
   * configuration, so a `category` label would be a series count an
   * administrator grows through a form with nobody watching this file.
   */
  it('records that a search was filtered, without room for the category', async () => {
    const m = metrics();
    m.recordListingSearch({
      radiusMiles: 5,
      outcome: 'empty',
      filtered: true,
      keyworded: false,
    });

    const text = await m.render();
    expect(text).toContain('filtered="true"');
    expect(text).not.toContain('outdoor-gardening');
  });

  /**
   * **The cardinality budget, asserted rather than described.**
   *
   * A series exists per distinct label combination and is held in process memory
   * for as long as the process lives. This is what stops "add a useful label"
   * from being a free decision later: five radii times four outcomes times the
   * two states of the filter times the two states of the keyword is eighty
   * series and no more, whatever traffic arrives. The compiler already refuses a
   * sixth radius and a third filter state; this refuses a quietly widened label
   * set.
   *
   * **It was twenty until slice 3.2a and forty until 3.3a**, and each doubling
   * was the price of one boolean — paid deliberately, and the number is written
   * down here so that the next label is a decision somebody has to make rather
   * than one that happens. **Two more booleans would put it at 320**, which is
   * the point at which the honest answer is a different metric rather than
   * another label.
   */
  it('cannot exceed eighty series however many searches arrive', async () => {
    const m = metrics();
    const radii = [5, 10, 20, 50, 100] as const;
    const outcomes = ['found', 'empty', 'beyond_end', 'unplaceable'] as const;

    for (let i = 0; i < 50; i++) {
      for (const radiusMiles of radii) {
        for (const outcome of outcomes) {
          for (const filtered of [true, false]) {
            for (const keyworded of [true, false]) {
              m.recordListingSearch({ radiusMiles, outcome, filtered, keyworded });
            }
          }
        }
      }
    }

    const series = (await m.render())
      .split('\n')
      .filter((line) => line.startsWith('listing_searches_total{'));

    expect(series).toHaveLength(80);
  });

  /**
   * **No postcode can reach the exposition, and the type is what guarantees it**
   * — there is no field on the sample a postcode could occupy. This asserts the
   * consequence, because the guarantee is the kind that gets quietly widened by
   * somebody adding "just an origin label" to help with debugging.
   *
   * A postcode in a label is an area of interest kept in process memory and
   * exported to a scraper with none of §10.1's retention or erasure guarantees.
   * Deletion cannot reach it and nobody would think to look.
   *
   * **From slice 3.2a it guards a category slug too**, which is the same rule
   * with a different value: unbounded, configuration-driven, and personal only
   * in aggregate — but a series per category, held forever, for a question a
   * boolean answers.
   *
   * **From slice 3.3a it guards the search term, and that is the one this test
   * exists for.** A radius is five values and a category slug is at least a set
   * an administrator deliberately created; a search term is whatever a stranger
   * typed into a box, so it can carry a name, a street or a full postcode. Of
   * everything this system could put in a label, it is the only one that is
   * unbounded *and* free text *and* supplied by the public.
   */
  it('exposes no label but radius, outcome, filtered and keyworded', async () => {
    const m = metrics();
    m.recordListingSearch({
      radiusMiles: 10,
      outcome: 'found',
      filtered: false,
      keyworded: false,
    });

    expect(labelsOf(await m.render(), 'listing_searches_total')).toEqual([
      'filtered',
      'keyworded',
      'outcome',
      'radius',
      'service',
    ]);
  });

  /*
   * The consequence of the rule above, asserted the way the category one is:
   * record a keyworded search and prove the words are nowhere in the exposition.
   * The type is the guarantee — there is no field a term could occupy — and this
   * is what would fail if somebody added one "just for debugging".
   */
  it('records that a search was keyworded, without room for the words', async () => {
    const m = metrics();
    m.recordListingSearch({
      radiusMiles: 5,
      outcome: 'empty',
      filtered: false,
      keyworded: true,
    });

    const text = await m.render();
    expect(text).toContain('keyworded="true"');
    expect(text).not.toContain('hedge');
    expect(text).not.toContain('BS7');
  });
});

/**
 * How the geocoder behaved (slice 3.1f).
 *
 * Three outcomes that `geocodeQuietly` distinguishes and then deliberately
 * collapses into one null for its callers — so before this, the difference
 * between "that postcode does not exist" and "our provider is down" existed
 * nowhere but a log line.
 */
describe('recording a geocode', () => {
  it('times the call and labels how it ended', async () => {
    const m = metrics();
    m.recordGeocode({ outcome: 'found', durationMs: 120 });

    const text = await m.render();
    expect(text).toContain('geocode_duration_seconds');
    expect(text).toContain('outcome="found"');
  });

  it('keeps an unknown postcode apart from an unreachable provider', async () => {
    const m = metrics();
    m.recordGeocode({ outcome: 'unknown', durationMs: 40 });
    m.recordGeocode({ outcome: 'unavailable', durationMs: 2_501 });

    const text = await m.render();
    expect(text).toContain('outcome="unknown"');
    expect(text).toContain('outcome="unavailable"');
  });

  /**
   * **The timeout has a readable signature, and that is why 2.5 and 5 are both
   * buckets.** The adapter aborts at 2500 ms, so a timed-out call takes slightly
   * more than 2.5 s and lands in `le=5` but not `le=2.5`. Anybody reading the
   * dashboard can see timeouts without knowing how the adapter is written.
   */
  it('puts a timed-out call above the 2.5 second bucket', async () => {
    const m = metrics();
    m.recordGeocode({ outcome: 'unavailable', durationMs: 2_501 });

    const text = await m.render();
    expect(valueOf(text, 'geocode_duration_seconds_bucket', 'le="2.5"')).toBe('0');
    expect(valueOf(text, 'geocode_duration_seconds_bucket', 'le="5"')).toBe('1');
  });

  it('converts milliseconds to seconds, as Prometheus convention expects', async () => {
    const m = metrics();
    m.recordGeocode({ outcome: 'found', durationMs: 250 });

    expect(valueOf(await m.render(), 'geocode_duration_seconds_sum', 'outcome')).toBe(
      '0.25',
    );
  });
});

describe('the exposition', () => {
  it('carries the service as a default label, so two services do not merge', async () => {
    const api = createPrometheusMetrics({ service: 'api' });
    api.recordHttpRequest({
      method: 'GET',
      route: '/a',
      statusCode: 200,
      durationMs: 1,
    });

    expect(await api.render()).toContain('service="api"');
  });

  /**
   * The numbers that answer "does it hold up under load". A service slow because
   * the event loop is blocked looks identical, from request timings alone, to
   * one slow because Postgres is.
   */
  it('includes Node process metrics', async () => {
    const text = await metrics().render();

    expect(text).toContain('nodejs_eventloop_lag_seconds');
    expect(text).toContain('process_resident_memory_bytes');
  });

  it('uses a private registry, so two instances do not collide', () => {
    // Registering the same metric names twice on the default registry throws.
    expect(() => {
      metrics();
      metrics();
    }).not.toThrow();
  });

  /**
   * The constant and the library must agree. A Nest `@Header()` decorator needs
   * a compile-time value, so the constant exists independently of the registry
   * that is the real authority — and an upgrade changing the format version
   * should fail here rather than serve a scraper the wrong header.
   */
  it('serves the content type the library itself reports', () => {
    expect(metrics().contentType).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(createNoopMetrics().contentType).toBe(PROMETHEUS_CONTENT_TYPE);
  });
});

describe('metrics turned off', () => {
  /**
   * The rule the whole codebase follows: an unconfigured dependency degrades to
   * doing nothing, never to taking its caller down.
   */
  it('records without throwing', () => {
    const m = createNoopMetrics();

    expect(() => {
      m.recordHttpRequest({
        method: 'GET',
        route: '/a',
        statusCode: 200,
        durationMs: 1,
      });
      m.recordDatabaseQuery({ operation: 'x', durationMs: 1 });
      m.recordQueueJob({
        queue: 'maintenance',
        jobName: 'heartbeat',
        durationMs: 1,
        outcome: 'completed',
      });
      m.recordListingSearch({
        radiusMiles: 5,
        outcome: 'empty',
        filtered: false,
        keyworded: false,
      });
      m.recordGeocode({ outcome: 'unavailable', durationMs: 2_501 });
    }).not.toThrow();
  });

  /**
   * **Records nothing, rather than recording into a registry nobody scrapes.**
   * Worth its own assertion because the no-op is what a search runs through when
   * `METRICS_ENABLED` is off, and a fake that quietly accumulated would be a
   * memory leak in exactly the configuration chosen to avoid one.
   */
  it('leaves the exposition empty even after recording a search', async () => {
    const m = createNoopMetrics();
    m.recordListingSearch({
      radiusMiles: 100,
      outcome: 'found',
      filtered: false,
      keyworded: false,
    });
    m.recordGeocode({ outcome: 'found', durationMs: 10 });

    expect(await m.render()).toBe('');
  });

  /**
   * Empty is still valid exposition text, so a scraper sees a live endpoint with
   * no series — a much clearer signal than a refused connection.
   */
  it('renders an empty exposition rather than failing', async () => {
    expect(await createNoopMetrics().render()).toBe('');
    expect(createNoopMetrics().contentType).toContain('text/plain');
  });
});

/**
 * The media refusal counter (slice 2.6c, deferred from 2.6b-i).
 *
 * The reason it exists: five of its six reasons are the owner's problem and one
 * — `storage-unavailable` — is ours, and the HTTP histogram cannot tell them
 * apart because both are just a non-2xx on the same route.
 */
describe('recording a media refusal', () => {
  it('counts a refusal by reason', async () => {
    const m = metrics();
    m.recordMediaRefusal({ reason: 'too-many-bytes' });

    const text = await m.render();
    expect(text).toContain('listing_media_refusals_total');
    expect(text).toContain('reason="too-many-bytes"');
  });

  it('keeps each reason as its own series', async () => {
    const m = metrics();
    m.recordMediaRefusal({ reason: 'too-many-bytes' });
    m.recordMediaRefusal({ reason: 'too-many-bytes' });
    m.recordMediaRefusal({ reason: 'storage-unavailable' });

    const text = await m.render();
    expect(valueOf(text, 'listing_media_refusals_total', 'too-many-bytes')).toBe('2');
    expect(valueOf(text, 'listing_media_refusals_total', 'storage-unavailable')).toBe(
      '1',
    );
  });

  it('carries no label but the reason', async () => {
    /*
     * **The cardinality rule, asserted rather than trusted.** A filename, a
     * listing id or a byte size here would each mint a series per value in a
     * store with none of §10.1's retention or erasure rules — and a filename is
     * free text somebody chose, which can carry a name.
     */
    const m = metrics();
    m.recordMediaRefusal({ reason: 'not-an-image' });

    /*
     * `labelsOf` returns label *names*, which is the assertion that matters:
     * one label of our own, and no second one carrying anything unbounded.
     * `service` is the registry-wide default label every metric here carries.
     */
    expect(labelsOf(await m.render(), 'listing_media_refusals_total')).toEqual([
      'reason',
      'service',
    ]);
  });

  it('holds at six series however many refusals arrive', async () => {
    const m = metrics();
    const reasons = [
      'too-many-bytes',
      'too-many-pixels',
      'unsupported-format',
      'not-an-image',
      'too-many-photographs',
      'storage-unavailable',
    ] as const;

    for (const reason of reasons) {
      for (let i = 0; i < 5; i++) m.recordMediaRefusal({ reason });
    }

    const lines = (await m.render())
      .split('\n')
      .filter((line) => line.startsWith('listing_media_refusals_total{'));

    expect(lines).toHaveLength(reasons.length);
  });
});
