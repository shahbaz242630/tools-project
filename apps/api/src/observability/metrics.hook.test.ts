import { describe, expect, it } from 'vitest';
import type { Metrics } from '@platform/observability';
import { createRecordingMetrics } from '@platform/observability/testing';
import { installMetricsHook } from './metrics.hook.js';
import type { HookReply, HookRequest, HookableServer } from './metrics.hook.js';

/**
 * **The shared fake rather than a literal written here**, since slice 3.1f.
 *
 * This file used to hand-roll two `Metrics` objects, which was fine while it was
 * the only place implementing the interface — and stopped being fine the moment
 * a second method arrived, because a hand-rolled double is a place the compiler
 * reports as broken and a reader is tempted to patch with a stub. One fake means
 * a method added to `Metrics` is answered once, correctly, for everybody.
 */
function recording() {
  const { metrics, httpRequests } = createRecordingMetrics();
  return { samples: httpRequests, metrics };
}

/** A server that captures the hook so a test can fire it by hand. */
function fakeServer() {
  let handler: ((r: HookRequest, p: HookReply, done: () => void) => void) | null = null;
  const server: HookableServer = {
    addHook: (_event, h) => {
      handler = h;
      return undefined;
    },
  };
  return {
    server,
    respond(request: HookRequest, reply: HookReply): boolean {
      let completed = false;
      handler?.(request, reply, () => {
        completed = true;
      });
      return completed;
    },
  };
}

describe('the response hook', () => {
  it('records the matched route template', () => {
    const { samples, metrics } = recording();
    const { server, respond } = fakeServer();
    installMetricsHook(server, metrics);

    respond(
      {
        method: 'GET',
        url: '/listings/8fe74923-e424-421c-b5a2-590280af0fae',
        routeOptions: { url: '/listings/:id' },
      },
      { statusCode: 200, elapsedTime: 12.5 },
    );

    expect(samples).toEqual([
      { method: 'GET', route: '/listings/:id', statusCode: 200, durationMs: 12.5 },
    ]);
  });

  /**
   * The reason this is a Fastify hook and not a Nest interceptor: guards run
   * before interceptors, so a refused request never reaches one. An error-rate
   * metric blind to 401 and 403 is blind to credential stuffing, to a scanner
   * walking routes, and to a suspended account still trying.
   */
  it('records a request that a guard refused', () => {
    const { samples, metrics } = recording();
    const { server, respond } = fakeServer();
    installMetricsHook(server, metrics);

    respond({ method: 'GET', url: '/me' }, { statusCode: 401, elapsedTime: 1 });

    expect(samples[0]?.statusCode).toBe(401);
  });

  /**
   * A request that matched no route has no template at all — and those are the
   * ones carrying whatever somebody decided to probe for.
   */
  it('falls back to the requested path when no route matched', () => {
    const { samples, metrics } = recording();
    const { server, respond } = fakeServer();
    installMetricsHook(server, metrics);

    respond(
      { method: 'GET', url: '/wp-login.php' },
      { statusCode: 404, elapsedTime: 0.4 },
    );

    expect(samples[0]?.route).toBe('/wp-login.php');
    expect(samples[0]?.statusCode).toBe(404);
  });

  it('always calls done, so the response lifecycle is never stalled', () => {
    const { metrics } = recording();
    const { server, respond } = fakeServer();
    installMetricsHook(server, metrics);

    expect(respond({ method: 'GET', url: '/x' }, { statusCode: 200 })).toBe(true);
  });

  /**
   * This runs after the reply is sent, so a throw would surface as an unhandled
   * rejection rather than a failed request — worse than the failure it reports.
   */
  it('calls done even when the metrics backend throws', () => {
    // Built from the fake and then broken, rather than hand-rolled: the point
    // of the test is one method throwing, and spelling out the other five again
    // is what leaves this file behind the next time the interface grows.
    const metrics: Metrics = {
      ...createRecordingMetrics().metrics,
      recordHttpRequest: () => {
        throw new Error('registry exploded');
      },
    };
    const { server, respond } = fakeServer();
    installMetricsHook(server, metrics);

    expect(() =>
      respond({ method: 'GET', url: '/x' }, { statusCode: 200 }),
    ).not.toThrow();
    expect(respond({ method: 'GET', url: '/x' }, { statusCode: 200 })).toBe(true);
  });

  it('defaults a missing method and duration rather than recording undefined', () => {
    const { samples, metrics } = recording();
    const { server, respond } = fakeServer();
    installMetricsHook(server, metrics);

    respond({}, {});

    expect(samples[0]?.method).toBe('UNKNOWN');
    expect(samples[0]?.durationMs).toBe(0);
    expect(samples[0]?.route).toBe('');
  });
});
