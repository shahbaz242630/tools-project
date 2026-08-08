import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ME_PATH } from '@platform/contracts';
import { createPrometheusMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import {
  InMemoryCategoryStore,
  createListingFakes,
} from '../catalogue/testing/fakes.js';

/**
 * Metrics through the real application (slice H1).
 *
 * What only this level proves: that the interceptor is actually registered
 * globally, that a request through real routing produces a series, and that the
 * scrape endpoint is reachable without a session — the three things a unit test
 * of either piece cannot show.
 */
const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
};

let app: NestFastifyApplication;
let identity: IdentityFakes;

beforeEach(async () => {
  const audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  const categories = new InMemoryCategoryStore();

  identity.sessionVerifier.accept('alice-token', ALICE);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        checks: [],
        logger: createRecordingLogger().logger,
        // A real registry here, unlike every other integration test: this suite
        // is *about* the exposition, so a noop would assert nothing.
        metrics: createPrometheusMetrics({ service: 'api' }),
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(
          categories,
          audit.service,
          createRecordingLogger().logger,
        ),
        listings: createListingFakes(categories).service,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const scrape = () => app.inject({ method: 'GET', url: '/metrics' });

describe('the scrape endpoint', () => {
  /**
   * Deliberately unauthenticated. The API is not reachable from the internet —
   * only `web` joins the edge network and CI asserts it — so Prometheus scrapes
   * this from inside the stack, the same guarantee Postgres relies on.
   */
  it('answers without a session', async () => {
    const response = await scrape();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('is not cached, so a scraper never reads a stale exposition', async () => {
    expect((await scrape()).headers['cache-control']).toBe('no-store');
  });

  it('serves Node process metrics', async () => {
    expect((await scrape()).body).toContain('nodejs_eventloop_lag_seconds');
  });
});

describe('the interceptor, registered globally', () => {
  /**
   * The assertion that would fail if `APP_INTERCEPTOR` were dropped — which is
   * the failure mode worth guarding, because everything would still work and
   * nothing would be measured.
   */
  it('records a request that went through real routing', async () => {
    await app.inject({
      method: 'GET',
      url: ME_PATH,
      headers: { authorization: 'Bearer alice-token' },
    });

    const body = (await scrape()).body;
    expect(body).toContain('http_request_duration_seconds_count');
    expect(body).toContain('route="/me"');
    expect(body).toContain('status="2xx"');
  });

  it('records a refused request as well as a successful one', async () => {
    // No token: the guard refuses. An error-rate metric that only counted
    // successes would be worse than none.
    await app.inject({ method: 'GET', url: ME_PATH });

    expect((await scrape()).body).toContain('status="4xx"');
  });

  /**
   * The privacy guarantee, end to end: a real request carrying a real
   * identifier, and no identifier in the exposition.
   */
  it('never exposes an identifier from the path', async () => {
    await app.inject({
      method: 'GET',
      url: '/listings/8fe74923-e424-421c-b5a2-590280af0fae',
      headers: { authorization: 'Bearer alice-token' },
    });

    const body = (await scrape()).body;
    expect(body).not.toContain('8fe74923');
    expect(body).toContain('route="/listings/:id"');
  });

  it('measures the scrape endpoint itself, which is one more route', async () => {
    await scrape();

    expect((await scrape()).body).toContain('route="/metrics"');
  });
});
