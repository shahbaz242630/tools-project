/**
 * Requesting a booking through the real application (slice 4.5a).
 *
 * **What only this file can show.** The service is handed a renter id; everything
 * deciding *whose* id that is lives in the guard and the decorator. Five things are
 * pinned here and nowhere else: that an anonymous request cannot make a booking,
 * that a stranger's quote is a **404 and never a 403**, that a suspended account
 * may **read** a booking and not **make** one, and that the projection matches the
 * contract exactly.
 *
 * **The 409 is not pinned here**, and the test below says why: the availability
 * check refuses a taken period with a sentence long before the constraint is
 * reached, so the conflict code is only reachable from a real two-connection race.
 * `prisma-booking-store.db.test.ts` is where that lives.
 */

import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import {
  BOOKINGS_ROUTE,
  ME_PATH,
  bookingAcceptPath,
  bookingDeclinePath,
  bookingPath,
  listingQuotesPath,
  listingRequestsPath,
  parseBooking,
  parseListingRequests,
  parseRentalQuote,
} from '@platform/contracts';
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
import { createBookingFakes } from './testing/fakes.js';

const ADA = { clerkUserId: 'user_ada', sessionId: 'sess_a', email: 'ada@example.com' };
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };
const CAT = { clerkUserId: 'user_cat', sessionId: 'sess_c', email: 'cat@example.com' };

const MOWER = 'listing-mower';

/** A fixed clock, so the fixtures are never overtaken by the real date. */
const TODAY = '2026-07-01';
const now = (): Date => Time.startOfLocalDay(TODAY);

const A_QUOTE_REQUEST = {
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

  identity.sessionVerifier
    .accept('ada-token', ADA)
    .accept('bob-token', BOB)
    .accept('cat-token', CAT);

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
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  adaId = await idOf('ada-token');
  bobId = await idOf('bob-token');
  await idOf('cat-token');

  // Bob owns the mower; Ada is the renter.
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
  booking.store.givenOwner(MOWER, bobId);
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

/** A quote, made the way a renter makes one — through the route. */
async function quoteFor(token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: listingQuotesPath(MOWER),
    headers: auth(token),
    payload: A_QUOTE_REQUEST,
  });

  return parseRentalQuote(response.json()).id;
}

const requestBooking = (token: string | null, quoteId: string) =>
  app.inject({
    method: 'POST',
    url: BOOKINGS_ROUTE,
    ...(token === null ? {} : { headers: auth(token) }),
    payload: { quoteId },
  });

/** A live request from Ada against Bob's mower, made through the routes. */
async function aRequest(): Promise<string> {
  const quoteId = await quoteFor('ada-token');
  const response = await requestBooking('ada-token', quoteId);
  return parseBooking(response.json()).id;
}

const decide = (path: string, token: string | null) =>
  app.inject({
    method: 'POST',
    url: path,
    ...(token === null ? {} : { headers: auth(token) }),
  });

describe('answering a request (slice 4.6)', () => {
  /*
   * **What only this file can show.** The service is handed an owner id;
   * everything deciding *whose* it is lives in the guard and the decorator. What
   * is pinned here and nowhere else: that a renter cannot accept their own
   * request, that a stranger gets **404 and never 403**, that a suspended owner
   * may *read* what is waiting and not *answer* it, and that both projections
   * match the contract exactly.
   */

  it('accepts, and returns the booking in the shape the contract describes', async () => {
    const bookingId = await aRequest();

    const response = await decide(bookingAcceptPath(bookingId), 'bob-token');

    expect(response.statusCode).toBe(201);
    // Parsed rather than eyeballed: `strictObject`, so an instant or a stray
    // field reaching the wire fails here.
    const accepted = parseBooking(response.json());
    expect(accepted.state).toBe('ACCEPTED');
    expect(accepted.events.map((event) => event.toState)).toEqual([
      'REQUESTED',
      'ACCEPTED',
    ]);
  });

  it('declines', async () => {
    const bookingId = await aRequest();

    const response = await decide(bookingDeclinePath(bookingId), 'bob-token');

    expect(parseBooking(response.json()).state).toBe('DECLINED');
  });

  it('refuses anonymous decisions', async () => {
    const bookingId = await aRequest();

    expect((await decide(bookingAcceptPath(bookingId), null)).statusCode).toBe(401);
    expect((await decide(bookingDeclinePath(bookingId), null)).statusCode).toBe(401);
  });

  it('answers 404 to the renter, who is a party but not the decider', async () => {
    /*
     * **The one that matters most here.** Ada can *read* this booking — §8.6 gives
     * her the record — and must not be able to accept it on her own behalf. A 403
     * would be worse than useless: it would confirm the booking is real to
     * anybody who guessed an id, which is the whole reason scoped reads here
     * answer 404.
     */
    const bookingId = await aRequest();

    expect((await decide(bookingAcceptPath(bookingId), 'ada-token')).statusCode).toBe(
      404,
    );
    expect((await decide(bookingDeclinePath(bookingId), 'ada-token')).statusCode).toBe(
      404,
    );
  });

  it('answers 404 to a stranger', async () => {
    const bookingId = await aRequest();

    expect((await decide(bookingAcceptPath(bookingId), 'cat-token')).statusCode).toBe(
      404,
    );
  });

  it('answers 422 when the request has already been answered', async () => {
    const bookingId = await aRequest();
    await decide(bookingDeclinePath(bookingId), 'bob-token');

    const response = await decide(bookingAcceptPath(bookingId), 'bob-token');

    expect(response.statusCode).toBe(422);
    // A sentence and no `issues` array: nothing about the *shape* of the request
    // was wrong, so there is no field to put an error under.
    expect(response.json()).toMatchObject({ message: expect.any(String) });
    expect(response.json()).not.toHaveProperty('issues');
  });

  it('lists what is waiting, in the shape the contract describes', async () => {
    await aRequest();

    const response = await app.inject({
      method: 'GET',
      url: listingRequestsPath(MOWER),
      headers: auth('bob-token'),
    });

    expect(response.statusCode).toBe(200);
    const { requests } = parseListingRequests(response.json());
    expect(requests).toHaveLength(1);
    // §7.1's disclosure, on the wire rather than only in the service.
    expect(requests[0]?.conflictCount).toBe(0);
  });

  it('shows an owner nothing about a listing that is not theirs', async () => {
    await aRequest();

    const response = await app.inject({
      method: 'GET',
      url: listingRequestsPath(MOWER),
      headers: auth('cat-token'),
    });

    // 200 with nothing in it, never 403: an empty list tells a stranger nothing
    // about whether the listing id is real.
    expect(response.statusCode).toBe(200);
    expect(parseListingRequests(response.json()).requests).toEqual([]);
  });

  it('lets a suspended owner read what is waiting, and not answer it', async () => {
    /*
     * **ADR 0024's line, on the two halves of one page.** Suspension takes away
     * the ability to transact, not the ability to see — an owner who cannot read
     * their requests cannot understand why their calendar is filling up, and
     * accepting one binds them to a hire.
     */
    const bookingId = await aRequest();
    identity.users.suspend(bobId, 'admin', 'under review');

    const read = await app.inject({
      method: 'GET',
      url: listingRequestsPath(MOWER),
      headers: auth('bob-token'),
    });
    expect(read.statusCode).toBe(200);

    expect((await decide(bookingAcceptPath(bookingId), 'bob-token')).statusCode).toBe(
      403,
    );
  });
});

describe('requesting a booking', () => {
  it('creates one and returns it in the shape the contract describes', async () => {
    const quoteId = await quoteFor('ada-token');

    const response = await requestBooking('ada-token', quoteId);

    expect(response.statusCode).toBe(201);
    // Parsed rather than eyeballed: a `strictObject`, so this fails if an instant
    // or an unexpected field reaches the wire.
    const made = parseBooking(response.json());
    expect(made.state).toBe('REQUESTED');
    expect(made.total).toEqual(gbp(5_832));
    expect(made.itemTitle).toBe('Petrol hedge trimmer');
    expect(made.events).toHaveLength(1);
  });

  it('refuses an anonymous request', async () => {
    const quoteId = await quoteFor('ada-token');

    const response = await requestBooking(null, quoteId);

    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for somebody else’s quote', async () => {
    const quoteId = await quoteFor('ada-token');

    // Not 403: answering differently would confirm the quote id is real.
    const response = await requestBooking('cat-token', quoteId);

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a quote that does not exist', async () => {
    // The same answer as somebody else's quote, deliberately: a stranger must not
    // be able to tell a real quote id from an invented one.
    const response = await requestBooking('ada-token', 'quote-nonexistent');

    expect(response.statusCode).toBe(404);
  });

  it('refuses dates an accepted booking already holds', async () => {
    const quoteId = await quoteFor('ada-token');

    // An accepted booking already holds the week, written straight to the store —
    // this is about the code the route answers, not about the race itself.
    await booking.store.create({
      listingId: MOWER,
      renterId: await idOf('cat-token'),
      state: 'RESERVED',
      startAt: Time.startOfLocalDay('2026-08-21'),
      endAt: Time.startOfLocalDay('2026-08-24'),
      timeZone: 'Europe/London',
      quoteId: 'quote-theirs',
      categoryVersionId: 'category-version-2',
      itemCharge: gbp(5_400),
      renterFee: gbp(432),
      total: gbp(5_832),
      itemTitle: 'Petrol hedge trimmer',
      categoryName: 'Outdoor and gardening',
      requestExpiresAt: Time.addHours(now(), 48),
    });

    const response = await requestBooking('ada-token', quoteId);

    /*
     * **422 rather than 409 here, and that is correct.** The availability check
     * runs first and refuses with a sentence — a booked period is unavailable. The
     * 409 is for the narrower case where the calendar still read free and the
     * database refused, which only a real two-connection race produces
     * (`prisma-booking-store.db.test.ts`).
     */
    expect(response.statusCode).toBe(422);
    expect((response.json() as { message: string }).message).toMatch(
      /have been taken/i,
    );
  });

  it('answers 400 for a body that is not a request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: BOOKINGS_ROUTE,
      headers: auth('ada-token'),
      payload: { quote: 'not-the-field-name' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('reading a booking back', () => {
  it('gives it to the renter and to the owner', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());

    const asRenter = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });
    const asOwner = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('bob-token'),
    });

    expect(asRenter.statusCode).toBe(200);
    // §8.6 gives the owner the decision, so they must be able to read it.
    expect(asOwner.statusCode).toBe(200);
    expect(parseBooking(asOwner.json()).id).toBe(made.id);
  });

  it('answers 404 to anybody else', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());

    const response = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('cat-token'),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('suspension', () => {
  it('refuses a suspended renter a new booking', async () => {
    // ADR 0024: a suspended account may not transact, and making a booking is
    // transacting.
    const quoteId = await quoteFor('ada-token');
    identity.users.suspend(adaId, 'admin', 'under review');

    const response = await requestBooking('ada-token', quoteId);

    expect(response.statusCode).toBe(403);
  });

  it('still lets a suspended party read a booking they are in', async () => {
    // ADR 0024's other half: reading what we hold about you survives suspension.
    // Taking the record away would punish twice.
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());

    identity.users.suspend(adaId, 'admin', 'under review');

    const response = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });

    expect(response.statusCode).toBe(200);
  });
});
