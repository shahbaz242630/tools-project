/**
 * Quotes through the real application: real routing, real guard, real exception
 * filter (slice 4.4b).
 *
 * **What only this file can show.** The service tests are handed a renter id.
 * Everything that decides *whose* id that is lives in the guard and the
 * `@CurrentUser` decorator, and a rule enforced by a decorator is one that can be
 * lost by deleting the decorator. Four things are pinned here and nowhere else:
 * that an anonymous request cannot get a quote **at all**, that a listing nobody
 * can book is a **404 and never a 403**, that another renter's quote is a 404,
 * and that a refused period arrives as a **422 with a sentence** rather than as a
 * 500 or a field error.
 */

import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import { createNoopMetrics } from '@platform/observability';
import {
  ME_PATH,
  listingQuotesPath,
  parseRentalQuote,
  quotePath,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import {
  InMemoryCategoryStore,
  createListingFakes,
} from '../catalogue/testing/fakes.js';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { TEST_INTERNAL_TRIGGER_SECRET, createBookingFakes } from './testing/fakes.js';

const ADA = { clerkUserId: 'user_ada', sessionId: 'sess_a', email: 'ada@example.com' };
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const MOWER = 'listing-mower';

/** A fixed clock, so the fixtures below are never overtaken by the real date. */
const TODAY = '2026-07-01';
const now = (): Date => Time.startOfLocalDay(TODAY);

const A_REQUEST = {
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  postcode: 'BS7 8AA',
};

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

let app: NestFastifyApplication;
let identity: IdentityFakes;
let booking: ReturnType<typeof createBookingFakes>;
let adaId: string;
let bobId: string;

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
        listings: createListingFakes(categories).service,
        availability: booking.service,
        quotes: booking.quotes,
        bookings: booking.bookings,
        requestExpiry: booking.requestExpiry,
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
  bobId = await idOf('bob-token');

  // Bob owns the mower; Ada is the renter asking what it costs.
  booking.quotableListings.give({
    id: MOWER,
    ownerId: bobId,
    title: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    rates: { daily: gbp(1_800), weekend: null, weekly: gbp(9_000) },
    currentFeePolicy: {
      ownerCommissionBasisPoints: 1_600,
      renterFeeBasisPoints: 800,
      minimumBookingTotal: gbp(1_000),
      minimumPlatformFee: gbp(100),
    },
    currentMaximumRentalDays: 88,
    currentRequestExpiryHours: 48,
    currentCategoryVersionId: 'category-version-2',
  });
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

const askForQuote = (
  token: string | null,
  payload: object = A_REQUEST,
  listingId = MOWER,
) =>
  app.inject({
    method: 'POST',
    url: listingQuotesPath(listingId),
    ...(token === null ? {} : { headers: auth(token) }),
    payload,
  });

const readQuote = (token: string, quoteId: string) =>
  app.inject({ method: 'GET', url: quotePath(quoteId), headers: auth(token) });

describe('asking for a quote', () => {
  it('prices the period and returns it in the shape the contract describes', async () => {
    const response = await askForQuote('ada-token');

    expect(response.statusCode).toBe(201);
    // Parsed rather than eyeballed: `rentalQuoteSchema` is a `strictObject`, so
    // this fails if an instant or an unexpected field reaches the wire.
    const quote = parseRentalQuote(response.json());
    expect(quote.total).toEqual(gbp(5_832));
    expect(quote.days).toBe(3);
    expect(quote.postcode).toBe('BS7 8AA');
  });

  it('refuses an anonymous request', async () => {
    // §6.2's entity list names a postcode and no renter. Persisting one for
    // somebody with no account would be personal data with no erasure route.
    const response = await askForQuote(null);

    expect(response.statusCode).toBe(401);
    expect(booking.quoteStore.all()).toHaveLength(0);
  });

  it('answers 404, never 403, for a listing nobody can book', async () => {
    const response = await askForQuote('ada-token', A_REQUEST, 'listing-nobody');

    // A 403 would confirm the listing exists, which is the whole thing the
    // check protects.
    expect(response.statusCode).toBe(404);
  });

  it('refuses an owner a quote for their own listing, with a sentence', async () => {
    const response = await askForQuote('bob-token');

    expect(response.statusCode).toBe(422);
    const body = response.json() as { message: string; issues?: string[] };
    expect(body.message).toMatch(/your own listing/i);
    // No `issues` array: that shape means "these fields were rejected", and no
    // correction to a field would fix this.
    expect(body.issues).toBeUndefined();
  });

  it('answers 422 with a sentence for a period the law does not allow', async () => {
    const response = await askForQuote('ada-token', {
      ...A_REQUEST,
      endDate: '2027-06-01',
    });

    expect(response.statusCode).toBe(422);
    expect((response.json() as { message: string }).message).toMatch(/longest hire/i);
  });

  it('answers 400 with field issues for a malformed request', async () => {
    // The line the controller draws: a bad *shape* is a 400 with issues, a bad
    // *period* is a 422 with a sentence.
    const response = await askForQuote('ada-token', {
      startDate: 'the twentieth',
      endDate: '2026-08-23',
      postcode: 'BS7 8AA',
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { issues: string[] }).issues.join(' ')).toMatch(
      /YYYY-MM-DD/,
    );
  });

  it('answers 400 for a postcode that is not one', async () => {
    const response = await askForQuote('ada-token', {
      ...A_REQUEST,
      postcode: 'nowhere',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('reading a quote back', () => {
  it('returns the renter their own quote', async () => {
    const created = parseRentalQuote((await askForQuote('ada-token')).json());

    const response = await readQuote('ada-token', created.id);

    expect(response.statusCode).toBe(200);
    expect(parseRentalQuote(response.json())).toEqual(created);
  });

  it('answers 404 for somebody else’s quote', async () => {
    const created = parseRentalQuote((await askForQuote('ada-token')).json());

    // Not 403: answering differently would confirm the quote id exists.
    const response = await readQuote('bob-token', created.id);

    expect(response.statusCode).toBe(404);
  });

  it('refuses an anonymous read', async () => {
    const created = parseRentalQuote((await askForQuote('ada-token')).json());

    const response = await app.inject({ method: 'GET', url: quotePath(created.id) });

    expect(response.statusCode).toBe(401);
  });
});

describe('suspension', () => {
  it('refuses a suspended renter a quote', async () => {
    // ADR 0024: a suspended account may not transact, and a quote is the first
    // step of making a booking. Neither route opts out with `@AllowsSuspended`.
    identity.users.suspend(adaId, 'admin', 'under review');

    const response = await askForQuote('ada-token');

    expect(response.statusCode).toBe(403);
    expect(booking.quoteStore.all()).toHaveLength(0);
  });
});
