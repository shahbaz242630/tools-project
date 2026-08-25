import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import {
  RECONCILE_PAYMENTS_ROUTE,
  parseReconciliationSweep,
} from '@platform/contracts';
import { AppModule } from '../app.module.js';
import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import {
  InMemoryCategoryStore,
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';

import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { INTERNAL_TRIGGER_HEADER } from '../internal-trigger/internal-trigger.guard.js';
import {
  TEST_INTERNAL_TRIGGER_SECRET,
  bookingModuleFakes,
} from '../booking/testing/fakes.js';

/**
 * The reconciliation trigger through the real stack (slice 5.4a, ADR 0048).
 *
 * **What only this file can show** is that the route is behind
 * `InternalTriggerGuard` and not behind `AuthGuard` — that a session token, however
 * valid, is not a credential here, and that a machine holding the secret gets
 * through. The sweep's own decisions are unit tested against the fake;
 * `bookings.integration.test.ts` proves the same properties for the expiry trigger,
 * and both matter separately because **the guard is applied per controller**.
 *
 * It also pins the projection: `reconciliationSweepSchema` is a `strictObject`, so
 * `parseReconciliationSweep` here fails if `failed` — a fact about the run rather
 * than about the payments — ever leaks onto the wire behind a spread.
 */

let app: NestFastifyApplication;

beforeEach(async () => {
  const audit = createAuditFakes();
  const identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  const categories = new InMemoryCategoryStore();

  // A real session, so "a valid token is still not a credential here" is proved
  // against one that genuinely works rather than against a rejected string.
  identity.sessionVerifier.accept('ada-token', {
    clerkUserId: 'user_ada',
    sessionId: 'sess_a',
    email: 'ada@example.com',
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter: allowAllRateLimiter,
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
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(
          categories,
          audit.service,
          createRecordingLogger().logger,
        ),
        featureFlags: createFeatureFlagFakes(audit).service,
        ...listingModuleFakes(categories),
        ...bookingModuleFakes(),
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

const trigger = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: RECONCILE_PAYMENTS_ROUTE, headers });

const secret = { [INTERNAL_TRIGGER_HEADER]: TEST_INTERNAL_TRIGGER_SECRET };

describe('who may set off a reconciliation sweep', () => {
  it('refuses a caller with no secret', async () => {
    expect((await trigger()).statusCode).toBe(401);
  });

  it('refuses a caller with the wrong secret', async () => {
    const response = await trigger({
      [INTERNAL_TRIGGER_HEADER]: 'not-the-secret-but-the-same-sort-of-length',
    });

    expect(response.statusCode).toBe(401);
  });

  /**
   * **The one that matters most, and it is per controller.** A signed-in person —
   * any signed-in person — must not be able to set off platform-wide work against a
   * payment provider. `AuthGuard` is not on this route, so a bearer token is simply
   * not a credential here. `bookings.integration.test.ts` pins the same thing for
   * the expiry trigger; neither test covers the other, because `@UseGuards` is
   * applied to each controller separately and a new one can forget it.
   */
  it('refuses a session token, however valid', async () => {
    const response = await trigger({ authorization: 'Bearer ada-token' });

    expect(response.statusCode).toBe(401);
  });

  it('lets a machine holding the secret through', async () => {
    // A guard proved only by refusing is a guard that might be refusing everybody.
    expect((await trigger(secret)).statusCode).toBe(200);
  });
});

describe('what it answers', () => {
  it('returns the shape the contract describes', async () => {
    const response = await trigger(secret);

    // Parsed rather than eyeballed. `strictObject`, so a stray field fails here —
    // including `failed`, which is deliberately not projected.
    expect(parseReconciliationSweep(response.json())).toEqual({
      examined: 0,
      settled: 0,
      stillPending: 0,
      unreconcilable: 0,
      reachedLimit: false,
    });
  });

  /**
   * **200 with zeroes is success, and today it is the only outcome.** Nothing can
   * open a payment attempt while `booking.payment` is off, so the sweep finds
   * nothing — and answering 204 or 404 for that would make "nothing was stale"
   * indistinguishable from "the route is gone" in a worker's log.
   */
  it('succeeds when there is nothing to reconcile', async () => {
    const response = await trigger(secret);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ examined: 0 });
  });

  it('is a POST only, so nothing crawls it into running', async () => {
    const response = await app.inject({
      method: 'GET',
      url: RECONCILE_PAYMENTS_ROUTE,
      headers: secret,
    });

    expect(response.statusCode).toBe(404);
  });
});
