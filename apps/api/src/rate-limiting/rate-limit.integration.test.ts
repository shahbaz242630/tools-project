/**
 * The rate limit through the real application — slice H7a.
 *
 * **What only this file can show, and why it exists.** `rate-limit.guard.test.ts`
 * drives `canActivate` directly, which proves the decision and nothing about the
 * wiring. Three things live between that decision and a caller, and each can be
 * lost by deleting one line: whether `RateLimitGuard` is actually in
 * `@UseGuards` on a controller, whether the `@RateLimit` decorator survived on a
 * route, and whether the `Retry-After` header reaches the wire rather than being
 * set on an object Fastify already sent.
 *
 * That is this project's standing lesson — *a control that has never fired has
 * never been tested either* — applied to the control while writing it, rather
 * than to somebody else's a phase later.
 */

import { allowAllRateLimiter, FakeRateLimiter } from './testing/fakes.js';
import { paymentsModuleFakes } from '../payments/testing/fakes.js';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import { createNoopMetrics } from '@platform/observability';
import { BOOKINGS_ROUTE, ME_PATH } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import {
  InMemoryCategoryStore,
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import {
  TEST_INTERNAL_TRIGGER_SECRET,
  createBookingFakes,
} from '../booking/testing/fakes.js';

const ADA = { clerkUserId: 'user_ada', sessionId: 'sess_a', email: 'ada@example.com' };
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const now = (): Date => Time.startOfLocalDay('2026-07-01');

let app: NestFastifyApplication;
let identity: IdentityFakes;
let limiter: FakeRateLimiter;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** `GET /bookings` — a `read`-tier route, and one that needs no fixtures. */
const listBookings = (token: string) =>
  app.inject({ method: 'GET', url: BOOKINGS_ROUTE, headers: auth(token) });

async function boot(rateLimiter: FakeRateLimiter | typeof allowAllRateLimiter) {
  const audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  const categories = new InMemoryCategoryStore();
  const booking = createBookingFakes(now);

  identity.sessionVerifier.accept('ada-token', ADA).accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter,
        // Two reads, so the third is the one refused. Small on purpose: a test
        // that had to make three hundred requests to prove a limit would be
        // measuring the suite rather than the guard.
        rateLimits: { read: 2, write: 1 },
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
          accountData: identity.accountData,
          accountAdmin: identity.accountAdmin,
          roleApprovals: identity.roleApprovals,
          secondFactor: identity.secondFactor,
        },
        profiles: createProfileFakes(audit).service,
        audit: audit.service,
        catalogue: new CatalogueService(
          categories,
          audit.service,
          createRecordingLogger().logger,
        ),
        featureFlags: createFeatureFlagFakes(audit).service,
        ...listingModuleFakes(categories),
        availability: booking.service,
        quotes: booking.quotes,
        bookings: booking.bookings,
        requestExpiry: booking.requestExpiry,
        // Payments' slice of the options (slice 5.4a). These tests care about
        // neither payments nor reconciliation; the sweep is here because
        // `AppModuleOptions` requires every dependency, which is what stops a
        // boot site quietly forgetting one.
        ...paymentsModuleFakes(),
        internalTriggerSecret: TEST_INTERNAL_TRIGGER_SECRET,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}

afterEach(async () => {
  await app.close();
});

describe('the rate limit, through the real application (slice H7a)', () => {
  beforeEach(async () => {
    limiter = new FakeRateLimiter();
    await boot(limiter);
    // Provisioning spends a `read` on `/me`… except `/me` is not a limited
    // route, which is itself worth knowing: only the four controllers that
    // opted in are limited.
    await app.inject({ method: 'GET', url: ME_PATH, headers: auth('ada-token') });
  });

  it('refuses the request past the limit with a real 429', async () => {
    expect((await listBookings('ada-token')).statusCode).toBe(200);
    expect((await listBookings('ada-token')).statusCode).toBe(200);

    expect((await listBookings('ada-token')).statusCode).toBe(429);
  });

  it('puts Retry-After on the wire, not just on an object', async () => {
    // The failure this catches: setting a header after Fastify has begun the
    // reply is a no-op, and every unit test would still pass.
    await listBookings('ada-token');
    await listBookings('ada-token');

    const refused = await listBookings('ada-token');

    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('answers with a sentence a person can read', async () => {
    await listBookings('ada-token');
    await listBookings('ada-token');

    const body = (await listBookings('ada-token')).json() as { message: string };

    expect(body.message).toMatch(/wait a moment and try again/i);
    // Never the budget: naming it tells somebody probing what to work against.
    expect(body.message).not.toMatch(/\d/);
  });

  it('limits the caller who spent the allowance, not everybody', async () => {
    /*
     * **The one that would have shipped broken.** A key built from the tier
     * alone passes every single-caller test above and takes the route down for
     * the whole platform the first time one account is busy.
     */
    await app.inject({ method: 'GET', url: ME_PATH, headers: auth('bob-token') });
    await listBookings('ada-token');
    await listBookings('ada-token');
    expect((await listBookings('ada-token')).statusCode).toBe(429);

    expect((await listBookings('bob-token')).statusCode).toBe(200);
  });

  it('does not limit a route that opted out', async () => {
    // `/me` carries no `@RateLimit`, so it stays reachable after `/bookings`
    // has been exhausted — which is what keeps a limit from locking somebody
    // out of their own account page.
    await listBookings('ada-token');
    await listBookings('ada-token');
    expect((await listBookings('ada-token')).statusCode).toBe(429);

    const me = await app.inject({
      method: 'GET',
      url: ME_PATH,
      headers: auth('ada-token'),
    });

    expect(me.statusCode).toBe(200);
  });

  it('still refuses an anonymous caller before the limit is reached', async () => {
    // Ordering: `AuthGuard` runs first, so an unauthenticated request is a 401
    // rather than being counted against a key that does not exist.
    const response = await app.inject({ method: 'GET', url: BOOKINGS_ROUTE });

    expect(response.statusCode).toBe(401);
  });
});

describe('when the counter is unreachable, through the real application', () => {
  it('serves the request rather than the outage', async () => {
    limiter = new FakeRateLimiter();
    await boot(limiter);
    await app.inject({ method: 'GET', url: ME_PATH, headers: auth('ada-token') });

    limiter.failNext = true;

    expect((await listBookings('ada-token')).statusCode).toBe(200);
  });
});
