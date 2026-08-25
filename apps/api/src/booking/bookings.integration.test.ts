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

import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import {
  BOOKINGS_ROUTE,
  EXPIRE_REQUESTS_ROUTE,
  ME_PATH,
  OWNER_BOOKINGS_ROUTE,
  bookingAcceptPath,
  bookingPayPath,
  bookingDeclinePath,
  bookingPath,
  listingQuotesPath,
  listingRequestsPath,
  parseBooking,
  parseBookingDetail,
  parseBookingPayment,
  parseBookingSummaries,
  parseExpirySweep,
  parseListingRequests,
  parseOwnerBookings,
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
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { INTERNAL_TRIGGER_HEADER } from '../internal-trigger/internal-trigger.guard.js';
import { TEST_INTERNAL_TRIGGER_SECRET, createBookingFakes } from './testing/fakes.js';
import { paymentsModuleFakes } from '../payments/testing/fakes.js';

const ADA = { clerkUserId: 'user_ada', sessionId: 'sess_a', email: 'ada@example.com' };
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };
const CAT = { clerkUserId: 'user_cat', sessionId: 'sess_c', email: 'cat@example.com' };

const MOWER = 'listing-mower';

/**
 * A fixed clock, so the fixtures are never overtaken by the real date.
 *
 * **Mutable from slice 4.7a**, where the deadline is the thing under test: every
 * service in this module reads this one function, so `advanceHours` moves the quote
 * expiry, the request deadline and the sweep's idea of *now* together — which is
 * what makes an expiry test exercise the same clock the product does.
 */
const TODAY = '2026-07-01';
let clock = Time.startOfLocalDay(TODAY);
const now = (): Date => clock;

/** Move every service's clock forward. */
function advanceHours(hours: number): void {
  clock = Time.addHours(clock, hours);
}

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
  // Reset, or an expiry test leaves the next one starting two days late.
  clock = Time.startOfLocalDay(TODAY);
  booking = createBookingFakes(now);

  identity.sessionVerifier
    .accept('ada-token', ADA)
    .accept('bob-token', BOB)
    .accept('cat-token', CAT);

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
    currentDamageSecurity: {
      excessFloor: { amount: 7_500, currency: 'GBP' as const },
      excessPercentageBasisPoints: 1_500,
      recoveryCeiling: { amount: 50_000, currency: 'GBP' as const },
    },
    replacementValue: { amount: 24_000, currency: 'GBP' as const },
    currentCategoryVersionId: 'category-version-2',
  });
  booking.store.givenOwner(MOWER, bobId);
  /*
   * The same fact through the port Catalogue answers in production (slice 5.2c).
   * Paying needs a payee, and the store's own owner map is its internal business
   * — a test that let the two disagree would be exercising a arrangement that
   * cannot exist.
   */
  booking.ownership.give(MOWER, bobId);
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

describe('paying for a booking (slice 5.2c)', () => {
  /*
   * **What only this file can show.** The service is handed a renter id;
   * everything deciding *whose* it is lives in the guard and the decorator. What
   * is pinned here and nowhere else: that the **owner** gets 404 from the paying
   * route although they are a party to the booking, that a **suspended** renter
   * cannot pay although they can read, that anonymous is 401 before any of it,
   * and that the response matches the contract exactly.
   */

  /** An accepted booking, made through the routes the way both parties would. */
  async function anAcceptedBooking(): Promise<string> {
    const bookingId = await aRequest();
    await decide(bookingAcceptPath(bookingId), 'bob-token');
    return bookingId;
  }

  it('pays, and returns the shape the contract describes', async () => {
    const bookingId = await anAcceptedBooking();

    const response = await decide(bookingPayPath(bookingId), 'ada-token');

    expect(response.statusCode).toBe(201);
    // Parsed rather than eyeballed: `strictObject`, so a stray field — a
    // provider reference, an internal failure code — fails here.
    const paid = parseBookingPayment(response.json());
    expect(paid.booking.state).toBe('RESERVED');
    expect(paid.payment.status).toBe('succeeded');
  });

  it('carries the challenge token through to the payer', async () => {
    // The one field in this API that crosses to a browser for somebody else's
    // code to consume. It has to survive the projection intact.
    const bookingId = await anAcceptedBooking();
    booking.payments.willReport({
      status: 'pending_payer_action',
      payerAction: { kind: 'confirm_in_browser', token: 'challenge-token' },
    });

    const paid = parseBookingPayment(
      (await decide(bookingPayPath(bookingId), 'ada-token')).json(),
    );

    expect(paid.booking.state).toBe('AWAITING_PAYMENT');
    expect(paid.payment.payerAction?.token).toBe('challenge-token');
  });

  it('refuses anonymous payment', async () => {
    const bookingId = await anAcceptedBooking();

    expect((await decide(bookingPayPath(bookingId), null)).statusCode).toBe(401);
  });

  it('answers 404 to the owner, who is a party but not the payer', async () => {
    /*
     * **The mirror of the accept route's own most important test.** Bob can read
     * this booking — §8.6 gives him the record — and must not be able to pay for
     * it, which would let an owner move their own booking to `RESERVED`. A 403
     * would confirm the id is real to somebody who is not paying it.
     */
    const bookingId = await anAcceptedBooking();

    expect((await decide(bookingPayPath(bookingId), 'bob-token')).statusCode).toBe(404);
    expect(booking.payments.requests).toHaveLength(0);
  });

  it('answers 404 to a stranger', async () => {
    const bookingId = await anAcceptedBooking();

    expect((await decide(bookingPayPath(bookingId), 'cat-token')).statusCode).toBe(404);
  });

  it('answers 422 with a sentence when payment is switched off', async () => {
    /*
     * **The ordinary answer in production today**, because `booking.payment`
     * defaults off until 5.2e brings a provider. A sentence and no `issues`
     * array: nothing about the shape of the request was wrong.
     */
    const bookingId = await anAcceptedBooking();
    booking.paymentsEnabled.value = false;

    const response = await decide(bookingPayPath(bookingId), 'ada-token');

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ message: expect.any(String) });
    expect(response.json()).not.toHaveProperty('issues');
    expect(booking.payments.requests).toHaveLength(0);
  });

  it('answers 422 for a request nobody has accepted', async () => {
    const bookingId = await aRequest();

    expect((await decide(bookingPayPath(bookingId), 'ada-token')).statusCode).toBe(422);
  });

  it('refuses a suspended renter, who may still read the booking', async () => {
    /*
     * ADR 0024: suspension takes away the ability to transact, not the ability to
     * see what you are already party to. Paying is transacting; reading is not.
     */
    const bookingId = await anAcceptedBooking();
    identity.users.suspend(adaId, 'admin', 'under review');

    expect((await decide(bookingPayPath(bookingId), 'ada-token')).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: bookingPath(bookingId),
          headers: auth('ada-token'),
        })
      ).statusCode,
    ).toBe(200);
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
      // No damage security: these fixtures are about dates and constraints.
      appliedExcess: null,
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
  /**
   * §8.7.2's *"shown to both parties before booking. Bookings retain the values
   * current at creation."* through the real stack (slice 5.5b-ii).
   *
   * **Both halves in one place, because the section is one sentence.** The
   * renter's copy on the booking they made, and the owner's on the request they
   * are being asked to accept — and both come off the row rather than off the
   * listing, which is what makes them agree.
   */
  it('shows both parties the same hold, from the booking rather than the listing', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());

    expect(made.appliedExcess).toEqual({ amount: gbp(7_500), boundBy: 'floor' });
    // §3.4.4 — refundable security is never folded into the price.
    expect(made.total).toEqual(gbp(5_832));

    const waiting = await app.inject({
      method: 'GET',
      url: listingRequestsPath(MOWER),
      headers: auth('bob-token'),
    });

    const { requests } = parseListingRequests(waiting.json());
    expect(requests[0]?.appliedExcess).toEqual(made.appliedExcess);
  });

  /**
   * **Both parties read this projection, and every "you" on the page depends on
   * which** (slice 5.5b-ii). Found by opening the page: an owner reading their
   * own booking was told the damage hold sat on *their* card, which is false —
   * §8.7.2 puts it on the renter's. `payability` already knew the difference and
   * only said it in prose.
   */
  it('names which party is reading it', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());

    const asRenter = parseBookingDetail(
      (
        await app.inject({
          method: 'GET',
          url: bookingPath(made.id),
          headers: auth('ada-token'),
        })
      ).json(),
    );
    const asOwner = parseBookingDetail(
      (
        await app.inject({
          method: 'GET',
          url: bookingPath(made.id),
          headers: auth('bob-token'),
        })
      ).json(),
    );

    expect(asRenter.viewer).toBe('renter');
    expect(asOwner.viewer).toBe('owner');
    // The hold itself is the same fact for both — only the wording differs.
    expect(asOwner.appliedExcess).toEqual(asRenter.appliedExcess);
  });

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
    expect(parseBookingDetail(asOwner.json()).id).toBe(made.id);
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

  /**
   * **Whether the reader may pay, through the real stack (slice 5.2d).**
   *
   * The matrix is swept against the pure function in `payability.test.ts` and the
   * wiring is proved in the service test. What only *this* file can show is that
   * the field survives the projection — `bookingDetailSchema` is a `strictObject`,
   * so `parseBookingDetail` here is what would fail if the route answered the
   * collection shape or grew a stray field.
   */
  it('tells the renter they may pay, in the shape the contract describes', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());
    await decide(bookingAcceptPath(made.id), 'bob-token');

    const response = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });

    expect(parseBookingDetail(response.json()).payability).toEqual({ payable: true });
  });

  /**
   * **The ordinary answer in production today**, because `booking.payment` is off
   * in every environment until 5.2e. A renter's page renders this, so it is
   * asserted through the stack rather than assumed from the unit tests.
   */
  it('refuses when payment is switched off, and says nothing was charged', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());
    await decide(bookingAcceptPath(made.id), 'bob-token');
    booking.paymentsEnabled.value = false;

    const response = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });

    const payability = parseBookingDetail(response.json()).payability;
    expect(payability.payable).toBe(false);
    expect(payability.payable === false && payability.reason).toMatch(
      /not switched on yet/,
    );
  });

  it('tells the owner the renter pays, on the booking they can read', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());
    await decide(bookingAcceptPath(made.id), 'bob-token');

    const response = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('bob-token'),
    });

    const payability = parseBookingDetail(response.json()).payability;
    expect(payability.payable).toBe(false);
    expect(payability.payable === false && payability.reason).toMatch(/renter pays/);
  });

  /**
   * **The dead control this slice exists to remove, proved end to end.** The read
   * is `@AllowsSuspended()` and the pay route is not, so without the suspension
   * check the page would draw a live button that the guard answers 403 to. Only
   * this file can show it, because the guard is what resolves suspension.
   */
  it('does not offer a suspended renter a payment the guard would refuse', async () => {
    const quoteId = await quoteFor('ada-token');
    const made = parseBooking((await requestBooking('ada-token', quoteId)).json());
    await decide(bookingAcceptPath(made.id), 'bob-token');
    identity.users.suspend(adaId, 'admin', 'under review');

    const read = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });
    const paying = await decide(bookingPayPath(made.id), 'ada-token');

    const payability = parseBookingDetail(read.json()).payability;
    expect(read.statusCode).toBe(200);
    expect(payability.payable).toBe(false);
    // The page says no, and the route agrees. Those two must never disagree.
    expect(paying.statusCode).toBe(403);
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

describe('the dashboards (slice 4.8a)', () => {
  /*
   * **What only this file can show.** The service is handed a user id; everything
   * deciding *whose* id that is lives in the guard and the decorator. What is
   * pinned here and nowhere else: that an anonymous caller gets nothing, that the
   * two projections match the contract exactly, that a suspended party may still
   * read their own list, and that the two routes really are two — a caller cannot
   * reach the owner's view by asking the renter's route for it.
   */
  const listMine = (token: string | null) =>
    app.inject({
      method: 'GET',
      url: BOOKINGS_ROUTE,
      ...(token === null ? {} : { headers: auth(token) }),
    });

  const listOwned = (token: string | null) =>
    app.inject({
      method: 'GET',
      url: OWNER_BOOKINGS_ROUTE,
      ...(token === null ? {} : { headers: auth(token) }),
    });

  it('refuses an anonymous caller both lists', async () => {
    expect((await listMine(null)).statusCode).toBe(401);
    expect((await listOwned(null)).statusCode).toBe(401);
  });

  it("sends the renter's list in the shape the contract states", async () => {
    const bookingId = await aRequest();

    const response = await listMine('ada-token');

    expect(response.statusCode).toBe(200);
    const listed = parseBookingSummaries(response.json());
    expect(listed.bookings.map((row) => row.id)).toEqual([bookingId]);
    expect(listed.truncated).toBe(false);
  });

  it("sends the owner's list in the shape the contract states", async () => {
    const bookingId = await aRequest();

    const response = await listOwned('bob-token');

    expect(response.statusCode).toBe(200);
    const listed = parseOwnerBookings(response.json());
    expect(listed.bookings.map((row) => row.id)).toEqual([bookingId]);
  });

  it('gives each party their own view of the same booking, and only that', async () => {
    /*
     * The two routes are two projections, not one shape behind a parameter. Ada
     * asked, so she reads an inclusive total; Bob owns the item, so he reads what
     * the hire earns him and nothing that could be mistaken for a payout.
     */
    await aRequest();

    const renter = parseBookingSummaries((await listMine('ada-token')).json());
    const owner = parseOwnerBookings((await listOwned('bob-token')).json());

    expect(renter.bookings[0]).toHaveProperty('total');
    expect(owner.bookings[0]).toHaveProperty('itemCharge');
    expect(owner.bookings[0]).not.toHaveProperty('total');
  });

  it('does not let the owner reach their view through the renter route', async () => {
    // Bob owns the mower and asked for nothing. The bare collection means *what
    // I requested*, and there is no parameter that widens it.
    await aRequest();

    const listed = parseBookingSummaries((await listMine('bob-token')).json());

    expect(listed.bookings).toEqual([]);
  });

  it('does not let the renter reach the owner view through the owner route', async () => {
    // Ada requested the booking and owns no listings. The route is scoped in the
    // query by who the session says she is.
    await aRequest();

    const listed = parseOwnerBookings((await listOwned('ada-token')).json());

    expect(listed.bookings).toEqual([]);
  });

  it('gives a third party nothing on either route', async () => {
    await aRequest();

    expect(
      parseBookingSummaries((await listMine('cat-token')).json()).bookings,
    ).toEqual([]);
    expect(parseOwnerBookings((await listOwned('cat-token')).json()).bookings).toEqual(
      [],
    );
  });

  it('answers 200 and an empty list, never a 404', async () => {
    // A collection scoped to the session always exists. A 404 here would be
    // saying "you have no bookings" in the vocabulary of "no such thing".
    expect((await listMine('cat-token')).statusCode).toBe(200);
    expect((await listOwned('cat-token')).statusCode).toBe(200);
  });

  it('still lets a suspended party read their own list', async () => {
    // ADR 0024: suspension takes away transacting, not seeing. A suspended
    // renter with a hire next week needs to look at it more than most people do.
    await aRequest();
    identity.users.suspend(adaId, 'admin', 'under review');

    const response = await listMine('ada-token');

    expect(response.statusCode).toBe(200);
    expect(parseBookingSummaries(response.json()).bookings).toHaveLength(1);
  });

  it('keeps a booking visible to both parties once it is answered', async () => {
    /*
     * The hole this slice exists to close. Before 4.8a an accepted booking left
     * the owner's requests panel the moment it was answered, the calendar drew
     * nothing, and the renter's only sight of it was a confirmation a reload lost.
     */
    const bookingId = await aRequest();
    await decide(bookingAcceptPath(bookingId), 'bob-token');

    const renter = parseBookingSummaries((await listMine('ada-token')).json());
    const owner = parseOwnerBookings((await listOwned('bob-token')).json());

    expect(renter.bookings[0]?.state).toBe('ACCEPTED');
    expect(owner.bookings[0]?.state).toBe('ACCEPTED');
  });

  it('shows a renter that their request expired', async () => {
    // 4.7a made a lapsed request say so in the database; until now nothing told
    // the person who made it. This is the first place they can see it.
    const bookingId = await aRequest();
    advanceHours(49);
    await app.inject({
      method: 'POST',
      url: EXPIRE_REQUESTS_ROUTE,
      headers: { [INTERNAL_TRIGGER_HEADER]: TEST_INTERNAL_TRIGGER_SECRET },
    });

    const listed = parseBookingSummaries((await listMine('ada-token')).json());

    expect(listed.bookings.map((row) => [row.id, row.state])).toEqual([
      [bookingId, 'EXPIRED'],
    ]);
  });
});

describe('the internal expiry trigger (slice 4.7a, ADR 0048)', () => {
  const trigger = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: EXPIRE_REQUESTS_ROUTE, headers });

  const secret = { [INTERNAL_TRIGGER_HEADER]: TEST_INTERNAL_TRIGGER_SECRET };

  it('refuses a caller with no secret', async () => {
    const response = await trigger();

    expect(response.statusCode).toBe(401);
  });

  it('refuses a caller with the wrong secret', async () => {
    const response = await trigger({
      [INTERNAL_TRIGGER_HEADER]: 'not-the-secret-but-the-same-sort-of-length',
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a session token, however valid', async () => {
    /*
     * **The one that matters most.** A signed-in person — any signed-in person —
     * must not be able to set off platform-wide scheduled work. `AuthGuard` is not
     * on this route, so a bearer token is simply not a credential here, and this
     * pins that rather than leaving it to the absence of a decorator.
     */
    const response = await trigger(auth('ada-token'));

    expect(response.statusCode).toBe(401);
  });

  it('answers 200 and expires nothing when nothing is overdue', async () => {
    await requestBooking('ada-token', await quoteFor('ada-token'));

    const response = await trigger(secret);

    expect(response.statusCode).toBe(200);
    expect(parseExpirySweep(response.json())).toEqual({
      expired: 0,
      bookingIds: [],
      reachedLimit: false,
    });
  });

  it('expires an overdue request, and the renter reads EXPIRED back', async () => {
    const made = parseBooking(
      (await requestBooking('ada-token', await quoteFor('ada-token'))).json(),
    );

    // Past the category's configured 48 hours. `clock` is what every service in
    // this module reads, so moving it moves the deadline for all of them at once.
    advanceHours(49);

    const response = await trigger(secret);

    expect(parseExpirySweep(response.json())).toMatchObject({
      expired: 1,
      bookingIds: [made.id],
    });

    // Read back through the renter's own route, which is the only view they have
    // of it until 4.8 — so this is what a person would actually see.
    const after = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });
    expect(parseBookingDetail(after.json()).state).toBe('EXPIRED');
  });

  it('returns only ids, never a renter or an item', async () => {
    /*
     * The trigger has no user and no scope, so anything richer than an id would be
     * handing an unscoped caller the terms of somebody's hire. `expirySweepSchema`
     * is a `strictObject`, so a field added on the server fails here rather than
     * being dropped in transit.
     */
    await requestBooking('ada-token', await quoteFor('ada-token'));
    advanceHours(49);

    const response = await trigger(secret);
    const body = JSON.stringify(response.json());

    expect(body).not.toContain(adaId);
    expect(body).not.toContain('hedge trimmer');
    expect(() => parseExpirySweep(response.json())).not.toThrow();
  });

  it('cannot expire a booking that was accepted first', async () => {
    // The whole point, end to end through the routes: an owner's acceptance
    // survives a sweep, however overdue the request's own deadline was.
    const made = parseBooking(
      (await requestBooking('ada-token', await quoteFor('ada-token'))).json(),
    );
    await app.inject({
      method: 'POST',
      url: bookingAcceptPath(made.id),
      headers: auth('bob-token'),
    });

    advanceHours(49);
    await trigger(secret);

    const after = await app.inject({
      method: 'GET',
      url: bookingPath(made.id),
      headers: auth('ada-token'),
    });
    expect(parseBookingDetail(after.json()).state).toBe('ACCEPTED');
  });
});

describe('one quote, one booking (slice 4.7a)', () => {
  it('refuses a second request from the same quote with a sentence, not a 500', async () => {
    /*
     * A double-press or a second tab. Before the unique index this made two
     * identical `REQUESTED` rows — invisible to §8.5.1's constraint, because §7.1
     * leaves `REQUESTED` out of the occupying states so several renters can ask for
     * the same dates.
     */
    const quoteId = await quoteFor('ada-token');
    const first = await requestBooking('ada-token', quoteId);
    expect(first.statusCode).toBe(201);

    const second = await requestBooking('ada-token', quoteId);

    expect(second.statusCode).toBe(422);
    expect((second.json() as { message: string }).message).toContain(
      'already requested',
    );
  });
});
