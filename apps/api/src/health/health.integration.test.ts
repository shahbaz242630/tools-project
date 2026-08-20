import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { DependencyCheck } from './dependency-check.js';
import { CORRELATION_HEADER } from '../observability/correlation.middleware.js';
import { createRecordingLogger } from '@platform/observability/testing';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  createCatalogueFakes,
  createListingFakes,
} from '../catalogue/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { bookingModuleFakes } from '../booking/testing/fakes.js';

/**
 * Boots the real application — real routing, real middleware, real exception
 * filter — against fake dependencies.
 *
 * The unit tests prove each part in isolation. This proves they are actually
 * wired together, which is the failure the unit tests cannot see: a controller
 * that works perfectly and was never registered still returns 404.
 */

const ok = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.resolve(),
});

const failing = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.reject(new Error('connection refused')),
});

let app: NestFastifyApplication | undefined;

async function boot(
  checks: readonly DependencyCheck[],
): Promise<NestFastifyApplication> {
  const { sessionVerifier, service, accountData, accountAdmin, roleApprovals } =
    createIdentityFakes();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter: allowAllRateLimiter,
        // A real registry is not wanted here: these tests are about routing and
        // authorisation, and a metrics backend that collected would make two
        // suites in one process share series.
        metrics: createNoopMetrics(),
        checks,
        logger: createRecordingLogger().logger,
        readinessTimeoutMs: 50,
        identity: {
          sessionVerifier,
          service,
          accountData,
          accountAdmin,
          roleApprovals,
        },
        profiles: createProfileFakes().service,
        audit: createAuditFakes().service,
        catalogue: createCatalogueFakes().service,
        featureFlags: createFeatureFlagFakes().service,
        listings: createListingFakes().service,
        ...bookingModuleFakes(),
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Build and discard one application before anything is timed.
 *
 * **A flake fix**, and the same one three other files needed — the diagnosis is
 * in `packages/database/src/prisma-config.test.ts`. Measured alone, the first
 * test here takes ~920 ms and every test after it takes 43–73 ms, because the
 * first `boot` is what compiles the Nest module graph, resolves every provider
 * and starts Fastify. That one-off belongs to the file, and billing it to
 * whichever test is written first is what let a saturated parallel run push it
 * past the five-second budget and report *"Test timed out in 5000ms"* against
 * an endpoint that answers in milliseconds.
 *
 * `afterEach` closes whatever `boot` last assigned, so this leaves nothing
 * running — and every test still builds its own application with its own
 * checks, which is the isolation this file depends on.
 */
beforeAll(async () => {
  await boot([ok('postgres')]);
  await app?.close();
  app = undefined;
});

describe('health endpoints, end to end', () => {
  it('serves liveness', async () => {
    const instance = (await boot([ok('postgres')])).getHttpAdapter().getInstance();
    const response = await instance.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('serves readiness with 200 when dependencies are up', async () => {
    const instance = (await boot([ok('postgres'), ok('redis')]))
      .getHttpAdapter()
      .getInstance();
    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('serves readiness with 503 when a dependency is down', async () => {
    const instance = (await boot([ok('postgres'), failing('redis')]))
      .getHttpAdapter()
      .getInstance();
    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { postgres: 'ok', redis: 'failed' },
    });
  });

  it('stays live while readiness fails', async () => {
    // The distinction that keeps a database outage from becoming a restart
    // loop: not ready, but emphatically not dead.
    const instance = (await boot([failing('postgres')])).getHttpAdapter().getInstance();

    const [health, ready] = await Promise.all([
      instance.inject({ method: 'GET', url: '/health' }),
      instance.inject({ method: 'GET', url: '/ready' }),
    ]);

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  });

  it('never leaks the underlying error into a 503 body', async () => {
    const instance = (await boot([failing('postgres')])).getHttpAdapter().getInstance();
    const response = await instance.inject({ method: 'GET', url: '/ready' });

    expect(response.body).not.toContain('connection refused');
  });

  it('returns a correlation id on every response', async () => {
    const instance = (await boot([ok('postgres')])).getHttpAdapter().getInstance();
    const response = await instance.inject({ method: 'GET', url: '/health' });

    expect(response.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an inbound correlation id', async () => {
    const instance = (await boot([ok('postgres')])).getHttpAdapter().getInstance();
    const response = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { [CORRELATION_HEADER]: 'trace-from-web' },
    });

    expect(response.headers[CORRELATION_HEADER]).toBe('trace-from-web');
  });

  it('correlates a request to a route that does not exist', async () => {
    // Proves the middleware is genuinely global rather than bound to the one
    // controller that happens to exist. A 404 is exactly the request someone
    // later needs to trace.
    const instance = (await boot([ok('postgres')])).getHttpAdapter().getInstance();
    const response = await instance.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
