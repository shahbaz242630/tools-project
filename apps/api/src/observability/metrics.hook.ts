import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Metrics } from '@platform/observability';
import { METRICS } from './metrics.tokens.js';

/**
 * The shape of a Fastify instance this hook needs, and nothing more.
 *
 * Narrow, for `CorrelationMiddleware`'s reason: it makes the hook testable with
 * a plain object, and it keeps the assertion about behaviour rather than about
 * Fastify's type surface.
 */
export interface HookableServer {
  addHook(
    event: 'onResponse',
    handler: (request: HookRequest, reply: HookReply, done: () => void) => void,
  ): unknown;
}

export interface HookRequest {
  readonly method?: string;
  readonly url?: string;
  /** Fastify's matched route template — `/listings/:id`, not the path. */
  readonly routeOptions?: { readonly url?: string };
}

export interface HookReply {
  readonly statusCode?: number;
  /** Milliseconds from request start to response, measured by Fastify. */
  readonly elapsedTime?: number;
}

/**
 * Records every response (slice H1).
 *
 * **A Fastify `onResponse` hook rather than a Nest interceptor, and the
 * difference is not stylistic.** Nest runs guards *before* interceptors, so an
 * interceptor never sees a request the auth guard refused — which is every 401
 * and every 403. An error-rate metric blind to rejected authentication is blind
 * to exactly the traffic worth watching: credential stuffing, a scanner walking
 * routes, a suspended account still trying. It also never sees a 404 that
 * matched no route at all, because there was no handler to intercept.
 *
 * `onResponse` fires for all of them. This was found by an integration test
 * asserting a refused request appears in the exposition, and failing.
 *
 * **The duration comes from Fastify's own `elapsedTime`**, which starts when the
 * request arrives rather than when a handler begins — so it includes the time
 * spent in guards and body parsing, which is time the caller waited.
 *
 * **Never throws.** A diagnostic must not be able to fail a response; this runs
 * after the reply is sent, so an error here would be an unhandled rejection
 * rather than a failed request, which is worse.
 */
@Injectable()
export class MetricsHook implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onModuleInit(): void {
    const server = this.adapterHost.httpAdapter?.getInstance<HookableServer>();
    // Guarded rather than asserted: a test that boots without an HTTP adapter
    // should not fail here, and an absent adapter means there are no responses
    // to record anyway.
    if (server === undefined || typeof server.addHook !== 'function') return;

    installMetricsHook(server, this.metrics);
  }
}

/**
 * Exported so a test can drive the hook against a plain object rather than a
 * booted application — and so the registration logic has one home whether it is
 * reached through Nest's lifecycle or directly.
 */
export function installMetricsHook(server: HookableServer, metrics: Metrics): void {
  server.addHook('onResponse', (request, reply, done) => {
    try {
      metrics.recordHttpRequest({
        method: request.method ?? 'UNKNOWN',
        // The matched template where there is one; the requested path
        // otherwise, which `normaliseRoute` then makes safe. A request that
        // matched no route has no template, and those carry whatever a scanner
        // decided to try.
        route: request.routeOptions?.url ?? request.url ?? '',
        statusCode: reply.statusCode ?? 0,
        durationMs: reply.elapsedTime ?? 0,
      });
    } catch {
      /*
       * Deliberately silent. This runs after the response is sent, so throwing
       * would surface as an unhandled rejection rather than a failed request —
       * and logging would run on every request during a broken-metrics
       * incident, turning a diagnostic problem into a log-volume one.
       */
    }

    done();
  });
}
