import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ME_PATH,
  listingAvailabilityBlockPath,
  listingAvailabilityPath,
  parseAvailabilityBlock,
  parseListingAvailability,
} from '@platform/contracts';
import { Time } from '@platform/core';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import {
  InMemoryCategoryStore,
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { TEST_INTERNAL_TRIGGER_SECRET, createBookingFakes } from './testing/fakes.js';
import { paymentsModuleFakes } from '../payments/testing/fakes.js';

/**
 * The owner's calendar through the real application: real routing, real guard,
 * real exception filter (slice 4.3b).
 *
 * **What only this file can show.** The service tests know nothing about who is
 * calling — they are handed an owner id. Everything that decides *whose* id that
 * is lives in the guard and the decorator, and a rule enforced by a decorator is
 * one that can be lost by deleting the decorator. Three things are pinned here
 * and nowhere else: that somebody else's listing is a **404 and never a 403**,
 * that suspension is allowed to *block* and refused to *unblock*, and that a
 * refusal arrives with the status a client can act on.
 */

const ADA = { clerkUserId: 'user_ada', sessionId: 'sess_a', email: 'ada@example.com' };
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const MOWER = 'listing-mower';

/** A fixed clock, so the fixtures below are never overtaken by the real date. */
const TODAY = '2026-07-01';
const now = (): Date => Time.startOfLocalDay(TODAY);

const A_PERIOD = { startDate: '2026-08-20', endDate: '2026-08-22', reason: 'Away' };

let app: NestFastifyApplication;
let identity: IdentityFakes;
let booking: ReturnType<typeof createBookingFakes>;
let adaId: string;

beforeEach(async () => {
  const audit: AuditFakes = createAuditFakes();
  identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  const categories = new InMemoryCategoryStore();
  booking = createBookingFakes(now);

  identity.sessionVerifier.accept('ada-token', ADA).accept('bob-token', BOB);

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

  // Provisioned by calling `/me`, as every other integration test does — the
  // mirror row is written just in time, so an id only exists after a request.
  adaId = await idOf('ada-token');
  await idOf('bob-token');
  booking.ownership.give(MOWER, adaId);
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

const readMonth = (token: string, month?: string) =>
  app.inject({
    method: 'GET',
    url:
      month === undefined
        ? listingAvailabilityPath(MOWER)
        : `${listingAvailabilityPath(MOWER)}?month=${month}`,
    headers: auth(token),
  });

const blockPeriod = (token: string, payload: object = A_PERIOD) =>
  app.inject({
    method: 'POST',
    url: listingAvailabilityPath(MOWER),
    headers: auth(token),
    payload,
  });

const unblockPeriod = (token: string, blockId: string) =>
  app.inject({
    method: 'DELETE',
    url: listingAvailabilityBlockPath(MOWER, blockId),
    headers: auth(token),
  });

async function anExistingBlock(): Promise<string> {
  const response = await blockPeriod('ada-token');
  return parseAvailabilityBlock(response.json()).id;
}

describe('reading a month', () => {
  it('answers with the month asked for', async () => {
    await blockPeriod('ada-token');

    const response = await readMonth('ada-token', '2026-08');

    expect(response.statusCode).toBe(200);
    const calendar = parseListingAvailability(response.json());
    expect(calendar.month).toBe('2026-08');
    expect(calendar.blocks).toHaveLength(1);
    expect(calendar.blocks[0]?.endDate).toBe('2026-08-22');
  });

  it('defaults to the current month in the platform’s timezone', async () => {
    // Not the caller's. A page asking "show me now" must not be the thing that
    // decides what now is — the browser's timezone is wherever the device is.
    const calendar = parseListingAvailability((await readMonth('ada-token')).json());

    expect(calendar.month).toBe('2026-07');
  });

  it('answers 400 for a month that is not one, rather than 500', async () => {
    // It goes straight into date arithmetic, which throws. Anybody can edit a
    // URL, so an unvalidated parameter here is a 500 on demand.
    const response = await readMonth('ada-token', 'august');

    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for somebody else’s listing, never 403', async () => {
    const response = await readMonth('bob-token', '2026-08');

    // 403 would confirm the listing exists, which is the whole thing the
    // ownership check protects.
    expect(response.statusCode).toBe(404);
  });

  it('answers 401 with no token at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: listingAvailabilityPath(MOWER),
    });

    expect(response.statusCode).toBe(401);
  });

  it('never carries an instant', async () => {
    /*
     * **The projection check, made against the raw body rather than the parsed
     * one.** `parseListingAvailability` is strict and would reject an extra
     * field — this asserts the same thing one layer earlier, so the failure
     * names what leaked rather than saying the contract did not match.
     */
    await blockPeriod('ada-token');
    const body = JSON.stringify((await readMonth('ada-token', '2026-08')).json());

    expect(body).not.toContain('startAt');
    expect(body).not.toContain('endAt');
    expect(body).not.toMatch(/T\d{2}:\d{2}/);
  });
});

describe('blocking a period', () => {
  it('creates it and answers 201 with the dates that were asked for', async () => {
    const response = await blockPeriod('ada-token');

    expect(response.statusCode).toBe(201);
    const block = parseAvailabilityBlock(response.json());
    expect(block).toMatchObject({
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: 'Away',
    });
  });

  it('answers 400 for a body that is the wrong shape', async () => {
    const response = await blockPeriod('ada-token', { startDate: 'the 20th' });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('startDate');
  });

  it('answers 422 for a period we will not accept, with the sentence to show', async () => {
    /*
     * **422 rather than 400, and the pair is the point.** Nothing about the
     * request's shape is wrong, so a client rendering field errors has no field
     * to attach this to. The message is the service's own words, verbatim.
     */
    const response = await blockPeriod('ada-token', {
      startDate: '2026-06-01',
      endDate: '2026-06-15',
    });

    expect(response.statusCode).toBe(422);
    expect((response.json() as { message: string }).message).toMatch(
      /already finished/,
    );
  });

  it('answers 404 for somebody else’s listing', async () => {
    const response = await blockPeriod('bob-token');

    expect(response.statusCode).toBe(404);
  });

  it('is allowed while suspended, because it offers strangers less', async () => {
    /*
     * **ADR 0024's line, not an exception to it.** A suspended account may not
     * write anything others would see; blocking dates takes an item *off* the
     * market, which is the same direction as pausing a listing — the one write
     * `owner-listings.controller.ts` also leaves open. Refusing it would force a
     * suspended owner to keep offering dates they cannot honour.
     */
    identity.users.suspend(adaId, 'admin', 'under review');

    expect((await blockPeriod('ada-token')).statusCode).toBe(201);
    expect((await readMonth('ada-token', '2026-08')).statusCode).toBe(200);
  });
});

describe('removing a period', () => {
  it('answers 204 and empties the month', async () => {
    const blockId = await anExistingBlock();

    const response = await unblockPeriod('ada-token', blockId);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(
      parseListingAvailability((await readMonth('ada-token', '2026-08')).json()).blocks,
    ).toEqual([]);
  });

  it('answers 404 the second time', async () => {
    const blockId = await anExistingBlock();
    await unblockPeriod('ada-token', blockId);

    expect((await unblockPeriod('ada-token', blockId)).statusCode).toBe(404);
  });

  it('answers 404 for somebody else’s block, and leaves it alone', async () => {
    // Bob has the two ids — both travel in URLs — and that must not be enough.
    const blockId = await anExistingBlock();

    expect((await unblockPeriod('bob-token', blockId)).statusCode).toBe(404);
    expect(
      parseListingAvailability((await readMonth('ada-token', '2026-08')).json()).blocks,
    ).toHaveLength(1);
  });

  it('is refused while suspended, because it puts dates back on offer', async () => {
    // The asymmetry with blocking, above. This is the write strangers would see.
    const blockId = await anExistingBlock();
    identity.users.suspend(adaId, 'admin', 'under review');

    expect((await unblockPeriod('ada-token', blockId)).statusCode).toBe(403);
  });
});
