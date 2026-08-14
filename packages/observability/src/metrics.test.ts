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
      queue: 'maintenance',
      jobName: 'sweep',
      durationMs: 1_200,
      outcome: 'completed',
    });

    const text = await m.render();
    expect(text).toContain('queue="maintenance"');
    expect(text).toContain('job="sweep"');
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
    m.recordListingSearch({ radiusMiles: 20, outcome: 'found' });

    const text = await m.render();
    expect(text).toContain('listing_searches_total');
    expect(text).toContain('radius="20"');
    expect(text).toContain('outcome="found"');
  });

  it('keeps the four outcomes apart, which is the whole point', async () => {
    const m = metrics();
    m.recordListingSearch({ radiusMiles: 5, outcome: 'found' });
    m.recordListingSearch({ radiusMiles: 5, outcome: 'empty' });
    m.recordListingSearch({ radiusMiles: 5, outcome: 'beyond_end' });
    m.recordListingSearch({ radiusMiles: 5, outcome: 'unplaceable' });

    const text = await m.render();
    for (const outcome of ['found', 'empty', 'beyond_end', 'unplaceable']) {
      expect(text).toContain(`outcome="${outcome}"`);
    }
  });

  it('accumulates rather than replacing, so a rate can be taken', async () => {
    const m = metrics();
    for (let i = 0; i < 3; i++) {
      m.recordListingSearch({ radiusMiles: 100, outcome: 'empty' });
    }

    expect(valueOf(await m.render(), 'listing_searches_total', 'radius="100"')).toBe(
      '3',
    );
  });

  /**
   * **The cardinality budget, asserted rather than described.**
   *
   * A series exists per distinct label combination and is held in process memory
   * for as long as the process lives. This is what stops "add a useful label"
   * from being a free decision later: five radii times four outcomes is twenty
   * series and no more, whatever traffic arrives. The compiler already refuses
   * a sixth radius; this refuses a quietly widened label set.
   */
  it('cannot exceed twenty series however many searches arrive', async () => {
    const m = metrics();
    const radii = [5, 10, 20, 50, 100] as const;
    const outcomes = ['found', 'empty', 'beyond_end', 'unplaceable'] as const;

    for (let i = 0; i < 50; i++) {
      for (const radiusMiles of radii) {
        for (const outcome of outcomes) {
          m.recordListingSearch({ radiusMiles, outcome });
        }
      }
    }

    const series = (await m.render())
      .split('\n')
      .filter((line) => line.startsWith('listing_searches_total{'));

    expect(series).toHaveLength(20);
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
   */
  it('exposes no label but radius and outcome', async () => {
    const m = metrics();
    m.recordListingSearch({ radiusMiles: 10, outcome: 'found' });

    expect(labelsOf(await m.render(), 'listing_searches_total')).toEqual([
      'outcome',
      'radius',
      'service',
    ]);
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
        queue: 'q',
        jobName: 'j',
        durationMs: 1,
        outcome: 'completed',
      });
      m.recordListingSearch({ radiusMiles: 5, outcome: 'empty' });
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
    m.recordListingSearch({ radiusMiles: 100, outcome: 'found' });
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
