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
    }).not.toThrow();
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
