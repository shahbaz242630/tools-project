import { beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import { BookingsService, RequestRefusedError } from './bookings.service.js';
import { OverlappingBookingError } from './booking-store.js';
import { QuotesService } from './quotes.service.js';
import {
  InMemoryAvailabilityStore,
  InMemoryBookingStore,
  InMemoryListingOwnership,
  InMemoryListingQuoteSource,
  InMemoryQuoteStore,
  RecordingHirePayments,
} from './testing/fakes.js';

/**
 * The request path (slice 4.5a).
 *
 * **What this file is about is the *sequence*, not the arithmetic.** The price is
 * the quote's, and every refusal here exists because a quote outlives the facts it
 * was built on: the listing can be withdrawn, the dates can go, and the price can
 * expire, all inside the thirty minutes a quote lives.
 */

const MOWER = 'listing-mower';
/**
 * The ordinary reader: signed in and not suspended (slice 5.2d).
 *
 * Named rather than inlined so the suspended case reads as the deliberate
 * departure it is, and so `find`'s third argument never looks like noise.
 */
const IN_GOOD_STANDING = { isSuspended: false } as const;

const ADA = 'user-ada';
const OWNER = 'user-owner';

/** A Thursday. Every test's "today", so nothing depends on when it runs. */
const NOW = Time.fromIsoUtc('2026-08-20T09:00:00.000Z');

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

const rates: ListingRateCard = { daily: gbp(1_800), weekend: null, weekly: gbp(9_000) };

const policy: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_600,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: gbp(1_000),
  minimumPlatformFee: gbp(100),
};

function mower(overrides: Record<string, unknown> = {}) {
  return {
    id: MOWER,
    ownerId: OWNER,
    title: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    rates,
    currentFeePolicy: policy,
    currentMaximumRentalDays: 88,
    currentRequestExpiryHours: 48,
    currentCategoryVersionId: 'category-version-2',
    ...overrides,
  };
}

const QUOTE_REQUEST = {
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  postcode: 'BS7 8AA',
};

describe('BookingsService', () => {
  let bookingStore: InMemoryBookingStore;
  let quoteStore: InMemoryQuoteStore;
  let listings: InMemoryListingQuoteSource;
  let availability: InMemoryAvailabilityStore;
  let payments: RecordingHirePayments;
  let ownership: InMemoryListingOwnership;
  let paymentsEnabled: { value: boolean };
  let quotes: QuotesService;
  let service: BookingsService;

  /** A quote for the mower, made the way a renter would make one. */
  async function givenAQuote(): Promise<string> {
    const quote = await quotes.quote(MOWER, ADA, QUOTE_REQUEST);
    if (quote === null) throw new Error('expected a quote');
    return quote.id;
  }

  beforeEach(() => {
    bookingStore = new InMemoryBookingStore(() => NOW).givenOwner(MOWER, OWNER);
    quoteStore = new InMemoryQuoteStore();
    listings = new InMemoryListingQuoteSource().give(mower());
    availability = new InMemoryAvailabilityStore(bookingStore);
    quotes = new QuotesService(quoteStore, listings, availability, () => NOW);
    payments = new RecordingHirePayments();
    ownership = new InMemoryListingOwnership().give(MOWER, OWNER);
    paymentsEnabled = { value: true };
    service = new BookingsService(
      bookingStore,
      quoteStore,
      listings,
      availability,
      payments,
      ownership,
      { isPaymentEnabled: () => Promise.resolve(paymentsEnabled.value) },
      () => NOW,
    );
  });

  describe('paying for a booking (§7, §8.7, slice 5.2c)', () => {
    /** An accepted booking, the way one is actually made. */
    async function givenAnAcceptedBooking(): Promise<string> {
      const quoteId = await givenAQuote();
      const booking = await service.request(ADA, { quoteId });
      if (booking === null) throw new Error('expected a booking');
      await service.accept(booking.id, OWNER);
      return booking.id;
    }

    it('reserves the booking when the charge succeeds', async () => {
      const bookingId = await givenAnAcceptedBooking();

      const paid = await service.pay(bookingId, ADA);

      expect(paid?.booking.state).toBe('RESERVED');
      expect(paid?.payment.status).toBe('succeeded');
      expect(paid?.payment.payerAction).toBeUndefined();
    });

    it('writes both transitions into the history', async () => {
      // §6.2 makes the event log part of what a booking *is*, and a payment that
      // jumped straight from ACCEPTED to RESERVED would be a history that cannot
      // explain how the money moved.
      const bookingId = await givenAnAcceptedBooking();

      const paid = await service.pay(bookingId, ADA);

      expect(paid?.booking.events.map((event) => event.toState)).toEqual([
        'REQUESTED',
        'ACCEPTED',
        'AWAITING_PAYMENT',
        'RESERVED',
      ]);
      // The first event has nothing to come from, and only the first — writing
      // `DRAFT` there would assert a state the booking was never in.
      expect(paid?.booking.events.map((event) => event.fromState)).toEqual([
        null,
        'REQUESTED',
        'ACCEPTED',
        'AWAITING_PAYMENT',
      ]);
    });

    it('hands the charge the booking’s own stored money, not the listing’s', async () => {
      // §8.2. A charge re-derived from the listing would bill today's price for
      // last month's hire.
      const bookingId = await givenAnAcceptedBooking();

      await service.pay(bookingId, ADA);

      const [request] = payments.requests;
      expect(request?.bookingId).toBe(bookingId);
      expect(request?.ownerId).toBe(OWNER);
      expect(request?.itemTitle).toBe('Petrol hedge trimmer');
      expect(request?.total.amount).toBeGreaterThan(0);
      // The parts add to the total, which is what `settleHire` refuses a charge
      // for failing — checked here so a wrong copy is caught at the seam too.
      expect((request?.itemCharge.amount ?? 0) + (request?.renterFee.amount ?? 0)).toBe(
        request?.total.amount,
      );
    });

    it('waits in AWAITING_PAYMENT while the payer answers their bank', async () => {
      /*
       * The ordinary UK card journey. §7 has this state precisely because a
       * payment under SCA does not finish in the request that started it.
       */
      const bookingId = await givenAnAcceptedBooking();
      payments.willReport({
        status: 'pending_payer_action',
        payerAction: { kind: 'confirm_in_browser', token: 'challenge-token' },
      });

      const paid = await service.pay(bookingId, ADA);

      expect(paid?.booking.state).toBe('AWAITING_PAYMENT');
      expect(paid?.payment.payerAction).toEqual({
        kind: 'confirm_in_browser',
        token: 'challenge-token',
      });
    });

    it('waits in AWAITING_PAYMENT while the provider is still deciding', async () => {
      // `processing` is not `pending_payer_action`: there is nothing for the payer
      // to do, and no token. Both leave the booking in the same place.
      const bookingId = await givenAnAcceptedBooking();
      payments.willReport({ status: 'processing' });

      const paid = await service.pay(bookingId, ADA);

      expect(paid?.booking.state).toBe('AWAITING_PAYMENT');
      expect(paid?.payment.payerAction).toBeUndefined();
    });

    it('moves to PAYMENT_FAILED with a sentence when the card is declined', async () => {
      const bookingId = await givenAnAcceptedBooking();
      payments.willReport({
        status: 'failed',
        failureMessage: 'Your card was declined.',
      });

      const paid = await service.pay(bookingId, ADA);

      expect(paid?.booking.state).toBe('PAYMENT_FAILED');
      expect(paid?.payment.failureMessage).toBe('Your card was declined.');
    });

    it('lets a declined renter try again — §7’s retry edge', async () => {
      const bookingId = await givenAnAcceptedBooking();
      payments.willReport({ status: 'failed', failureMessage: 'Declined.' });
      await service.pay(bookingId, ADA);

      payments.willReport({ status: 'succeeded' });
      const paid = await service.pay(bookingId, ADA);

      expect(paid?.booking.state).toBe('RESERVED');
      expect(payments.requests).toHaveLength(2);
    });

    it('resumes a payment left in flight rather than starting a new one', async () => {
      /*
       * **The crash case, and the reason both sides had to be idempotent.** A
       * renter who closed the tab mid-challenge, or a process that died between
       * the charge and the state change, leaves a booking in `AWAITING_PAYMENT`.
       * Calling this again is what repairs it — and Payments returns the attempt
       * already open rather than charging a second time, which is proved in
       * `payments.service.test.ts` against the real intent store.
       */
      const bookingId = await givenAnAcceptedBooking();
      payments.willReport({
        status: 'pending_payer_action',
        payerAction: { kind: 'confirm_in_browser', token: 'challenge-token' },
      });
      await service.pay(bookingId, ADA);

      payments.willReport({ status: 'succeeded' });
      const resumed = await service.pay(bookingId, ADA);

      expect(resumed?.booking.state).toBe('RESERVED');
      // No second `AWAITING_PAYMENT` event: §7 has no edge from that state to
      // itself, and one would be a history entry recording that nothing happened.
      expect(
        resumed?.booking.events.filter((event) => event.toState === 'AWAITING_PAYMENT'),
      ).toHaveLength(1);
    });

    it('refuses when payment is not switched on, before anything moves', async () => {
      /*
       * **The ordinary answer today.** There is no payment provider until 5.2e, so
       * the flag defaults off — and refusing here rather than at the provider is
       * what keeps a booking from being stranded in `AWAITING_PAYMENT` waiting for
       * something that cannot happen.
       */
      const bookingId = await givenAnAcceptedBooking();
      paymentsEnabled.value = false;

      await expect(service.pay(bookingId, ADA)).rejects.toThrow(/not switched on/);

      expect(payments.requests).toHaveLength(0);
      const booking = await service.find(bookingId, ADA, IN_GOOD_STANDING);
      expect(booking?.state).toBe('ACCEPTED');
    });

    it('refuses the owner, indistinguishably from a booking that does not exist', async () => {
      // §8.6 gives the owner the decision and the renter the bill. A 403 here
      // would confirm the id is real to somebody who is not paying it.
      const bookingId = await givenAnAcceptedBooking();

      expect(await service.pay(bookingId, OWNER)).toBeNull();
      expect(payments.requests).toHaveLength(0);
    });

    it('refuses a booking that is not this renter’s', async () => {
      const bookingId = await givenAnAcceptedBooking();

      expect(await service.pay(bookingId, 'renter-someone-else')).toBeNull();
    });

    it('refuses a booking that does not exist', async () => {
      expect(await service.pay('booking-nonexistent', ADA)).toBeNull();
    });

    it('refuses a request the owner has not answered yet', async () => {
      const quoteId = await givenAQuote();
      const booking = await service.request(ADA, { quoteId });

      await expect(service.pay(booking?.id ?? '', ADA)).rejects.toThrow(
        /has not been accepted yet/,
      );
      expect(payments.requests).toHaveLength(0);
    });

    it('refuses a booking that is already paid for, and charges nothing', async () => {
      const bookingId = await givenAnAcceptedBooking();
      await service.pay(bookingId, ADA);
      const chargesSoFar = payments.requests.length;

      await expect(service.pay(bookingId, ADA)).rejects.toThrow(/already paid for/);
      expect(payments.requests).toHaveLength(chargesSoFar);
    });

    it('refuses a declined booking', async () => {
      const quoteId = await givenAQuote();
      const booking = await service.request(ADA, { quoteId });
      await service.decline(booking?.id ?? '', OWNER);

      await expect(service.pay(booking?.id ?? '', ADA)).rejects.toThrow(
        /no longer live/,
      );
    });

    it('refuses when the listing has somehow lost its owner', async () => {
      /*
       * Unreachable in production — the foreign key is `RESTRICT` and accounts are
       * soft-deleted — and it is asked *before* the state moves precisely so the
       * impossible case cannot strand a booking mid-payment.
       */
      const bookingId = await givenAnAcceptedBooking();
      const orphaned = new BookingsService(
        bookingStore,
        quoteStore,
        listings,
        availability,
        payments,
        {
          isOwnedBy: () => Promise.resolve(false),
          ownerOf: () => Promise.resolve(null),
        },
        { isPaymentEnabled: () => Promise.resolve(true) },
        () => NOW,
      );

      await expect(orphaned.pay(bookingId, ADA)).rejects.toThrow(/no longer available/);

      expect(payments.requests).toHaveLength(0);
      const booking = await service.find(bookingId, ADA, IN_GOOD_STANDING);
      expect(booking?.state).toBe('ACCEPTED');
    });
  });

  describe('answering a request (§8.6, §7.1, slice 4.6)', () => {
    /** A request from Ada, the way one is actually made. */
    async function givenARequest(): Promise<string> {
      const quoteId = await givenAQuote();
      const booking = await service.request(ADA, { quoteId });
      if (booking === null) throw new Error('expected a booking');
      return booking.id;
    }

    it('accepts it, and rests in ACCEPTED', async () => {
      /*
       * **Not `AWAITING_PAYMENT`, and the choice is argued in the service.**
       * §7.1 says to move it to `ACCEPTED`; the two states after it are
       * *"payment secured"* and *"awaiting payment"*, and neither is true while
       * Phase 5 does not exist.
       */
      const bookingId = await givenARequest();

      const accepted = await service.accept(bookingId, OWNER);

      expect(accepted?.state).toBe('ACCEPTED');
    });

    it("records the acceptance in the booking's history", async () => {
      const bookingId = await givenARequest();

      const accepted = await service.accept(bookingId, OWNER);

      expect(accepted?.events.map((event) => [event.fromState, event.toState])).toEqual(
        [
          [null, 'REQUESTED'],
          ['REQUESTED', 'ACCEPTED'],
        ],
      );
    });

    it('declines it, and says a person did', async () => {
      const bookingId = await givenARequest();

      const declined = await service.decline(bookingId, OWNER);

      expect(declined?.state).toBe('DECLINED');
      // `state-changed` rather than `auto-declined`: the renter is owed the
      // difference between "the owner said no" and "somebody else was quicker".
      expect(declined?.events.at(-1)?.type).toBe('state-changed');
    });

    it("answers nothing about a booking that is not this owner's", async () => {
      const bookingId = await givenARequest();

      // Null both ways, so a stranger cannot learn a booking id is real.
      expect(await service.accept(bookingId, 'user-stranger')).toBeNull();
      expect(await service.decline(bookingId, 'user-stranger')).toBeNull();
    });

    it('refuses to accept one that has already been answered', async () => {
      const bookingId = await givenARequest();
      await service.decline(bookingId, OWNER);

      await expect(service.accept(bookingId, OWNER)).rejects.toThrow(
        /no longer waiting for an answer/,
      );
    });

    it('refuses to accept one whose deadline has passed', async () => {
      /*
       * §8.6's deadline. 4.7's worker will move these to `EXPIRED`; until then the
       * deadline is only real if whoever would act past it refuses to.
       */
      const bookingId = await givenARequest();
      const service48hLater = new BookingsService(
        bookingStore,
        quoteStore,
        listings,
        availability,
        payments,
        ownership,
        { isPaymentEnabled: () => Promise.resolve(paymentsEnabled.value) },
        () => Time.addHours(NOW, 49),
      );

      await expect(service48hLater.accept(bookingId, OWNER)).rejects.toThrow(/expired/);
    });

    it('still lets a late request be declined', async () => {
      /*
       * **The asymmetry, and it is deliberate.** The deadline exists so a renter
       * is not held indefinitely; saying no after it costs them nothing they had
       * not already lost, and refusing would leave the owner unable to clear a
       * request they can see.
       */
      const bookingId = await givenARequest();
      const service48hLater = new BookingsService(
        bookingStore,
        quoteStore,
        listings,
        availability,
        payments,
        ownership,
        { isPaymentEnabled: () => Promise.resolve(paymentsEnabled.value) },
        () => Time.addHours(NOW, 49),
      );

      expect((await service48hLater.decline(bookingId, OWNER))?.state).toBe('DECLINED');
    });

    it('refuses when the owner has since blocked the dates themselves', async () => {
      /*
       * **The check the phase handoff names**: `EXCLUDE` cannot span two tables,
       * so an availability block placed *after* a request arrived is invisible to
       * the constraint. Accepting would contradict the owner's own calendar.
       */
      const bookingId = await givenARequest();
      await availability.block({
        listingId: MOWER,
        startAt: Time.fromIsoUtc('2026-08-21T00:00:00.000Z'),
        endAt: Time.fromIsoUtc('2026-08-24T00:00:00.000Z'),
        reason: 'Away',
      });

      await expect(service.accept(bookingId, OWNER)).rejects.toThrow(
        /blocked some of those dates/,
      );
    });

    it('lists what is waiting, and what accepting each would displace', async () => {
      // §7.1: *"Owners must be shown, before accepting, that competing requests
      // exist and will be declined."*
      await givenARequest();
      await givenARequest();

      const { requests } = await service.pendingRequests(MOWER, OWNER);

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.conflictCount)).toEqual([1, 1]);
      // Dates on the wire, never instants — 4.3b's rule, and `strictObject`
      // is what would fail if an instant appeared here.
      expect(requests[0]?.startDate).toBe('2026-08-21');
      expect(requests[0]?.endDate).toBe('2026-08-23');
    });

    it('names no renter and states no payout', async () => {
      /*
       * **Two omissions, both deliberate and both easy to "fix" back in.** An
       * owner is deciding about dates and a price, not about a person (§8.4.1);
       * and §3.4 deducts the owner's commission from a payout that does not exist
       * until Phase 5, so any figure labelled as theirs would be a false sentence
       * about money.
       */
      await givenARequest();

      const { requests } = await service.pendingRequests(MOWER, OWNER);

      expect(Object.keys(requests[0] ?? {}).sort()).toEqual([
        'conflictCount',
        'days',
        'endDate',
        'id',
        'itemCharge',
        'requestExpiresAt',
        'startDate',
      ]);
      // The owner's own money, before our cut — not the renter's inclusive total.
      expect(requests[0]?.itemCharge).toEqual(gbp(5_400));
    });

    it("shows an owner nothing about somebody else's listing", async () => {
      await givenARequest();

      expect(await service.pendingRequests(MOWER, 'user-stranger')).toEqual({
        requests: [],
      });
    });
  });

  describe('making a request', () => {
    it('creates a booking in REQUESTED with the terms from the quote', async () => {
      const quoteId = await givenAQuote();

      const booking = await service.request(ADA, { quoteId });

      expect(booking?.state).toBe('REQUESTED');
      // Copied, not joined — §8.2 and the product owner's "all details".
      expect(booking?.itemTitle).toBe('Petrol hedge trimmer');
      expect(booking?.categoryName).toBe('Outdoor and gardening');
      expect(booking?.total).toEqual(gbp(5_832));
      expect(booking?.days).toBe(3);
      expect(booking?.startDate).toBe('2026-08-21');
      expect(booking?.endDate).toBe('2026-08-23');
    });

    it('records the first event, with no state to come from', async () => {
      const quoteId = await givenAQuote();

      const booking = await service.request(ADA, { quoteId });

      // §6.2's immutable state history begins here. `fromState` is null because
      // the booking was never in `DRAFT` — see the service docblock.
      expect(booking?.events).toEqual([
        {
          type: 'requested',
          fromState: null,
          toState: 'REQUESTED',
          at: '2026-08-20T09:00:00.000Z',
        },
      ]);
    });

    it('sets the deadline from the category’s configured hours', async () => {
      const quoteId = await givenAQuote();

      const booking = await service.request(ADA, { quoteId });

      // 48 hours from now, per §8.6's configurable deadline.
      expect(booking?.requestExpiresAt).toBe('2026-08-22T09:00:00.000Z');
    });

    it('takes the deadline from configuration rather than a constant', async () => {
      listings.give(mower({ currentRequestExpiryHours: 6 }));
      const quoteId = await givenAQuote();

      const booking = await service.request(ADA, { quoteId });

      expect(booking?.requestExpiresAt).toBe('2026-08-20T15:00:00.000Z');
    });

    it('pins the version the quote was priced under, not whatever is current now', async () => {
      const quoteId = await givenAQuote();

      // The category is reconfigured between the quote and the request — which is
      // exactly the half hour a quote lives.
      listings.give(mower({ currentCategoryVersionId: 'category-version-3' }));

      await service.request(ADA, { quoteId });

      // The booking keeps what the renter was quoted under (§8.2).
      expect(quoteStore.all()[0]?.categoryVersionId).toBe('category-version-2');
    });

    it('does not make the dates unavailable, because a request reserves nothing', async () => {
      // §7.1: `REQUESTED` is deliberately not calendar-occupying, so two people
      // may request the same week and acceptance decides.
      const quoteId = await givenAQuote();
      await service.request(ADA, { quoteId });

      expect(
        await availability.reasonUnavailable(
          MOWER,
          Time.startOfLocalDay('2026-08-21'),
          Time.startOfLocalDay('2026-08-24'),
        ),
      ).toBe(null);
    });
  });

  describe('what it refuses', () => {
    it('answers null for a quote that is not this renter’s', async () => {
      const quoteId = await givenAQuote();

      expect(await service.request('user-somebody-else', { quoteId })).toBe(null);
    });

    it('answers null for a quote that does not exist', async () => {
      expect(await service.request(ADA, { quoteId: 'quote-nonexistent' })).toBe(null);
    });

    it('refuses an expired price rather than quietly re-pricing', async () => {
      const quoteId = await givenAQuote();

      const later = new BookingsService(
        bookingStore,
        quoteStore,
        listings,
        availability,
        payments,
        ownership,
        { isPaymentEnabled: () => Promise.resolve(paymentsEnabled.value) },
        () => Time.fromIsoUtc('2026-08-20T09:31:00.000Z'),
      );

      await expect(later.request(ADA, { quoteId })).rejects.toThrow(
        /price has expired/i,
      );
    });

    it('refuses a listing that has been withdrawn since the quote', async () => {
      const quoteId = await givenAQuote();
      // The owner paused it, or the platform hid it. `findQuotable` answers null
      // for both, and for a listing that never existed.
      listings = new InMemoryListingQuoteSource();
      const withNoListing = new BookingsService(
        bookingStore,
        quoteStore,
        listings,
        availability,
        payments,
        ownership,
        { isPaymentEnabled: () => Promise.resolve(true) },
        () => NOW,
      );

      await expect(withNoListing.request(ADA, { quoteId })).rejects.toThrow(
        /no longer available/i,
      );
    });

    it('refuses an owner requesting their own listing', async () => {
      // Reachable only if they somehow hold a quote for it; the quote engine
      // refuses to issue one. Belt and braces on the path that writes a row.
      const quote = await quoteStore.create({
        listingId: MOWER,
        renterId: OWNER,
        startAt: Time.startOfLocalDay('2026-08-21'),
        endAt: Time.startOfLocalDay('2026-08-24'),
        timeZone: 'Europe/London',
        renterPostcode: 'BS7 8AA',
        itemCharge: gbp(5_400),
        renterFee: gbp(432),
        total: gbp(5_832),
        minimumFeeApplied: false,
        lineItems: [
          { unit: 'day', count: 3, unitPrice: gbp(1_800), subtotal: gbp(5_400) },
        ],
        categoryVersionId: 'category-version-2',
        expiresAt: Time.addHours(NOW, 1),
      });

      await expect(service.request(OWNER, { quoteId: quote.id })).rejects.toThrow(
        /your own listing/i,
      );
    });

    it('refuses dates that have been taken since the quote', async () => {
      const quoteId = await givenAQuote();

      await availability.block({
        listingId: MOWER,
        startAt: Time.startOfLocalDay('2026-08-22'),
        endAt: Time.startOfLocalDay('2026-08-24'),
        reason: 'Away at my mother’s',
      });

      const promise = service.request(ADA, { quoteId });

      await expect(promise).rejects.toThrow(/have been taken/i);
      // The owner's own note never reaches a renter.
      await expect(promise).rejects.not.toThrow(/mother/i);
    });

    it('lets an overlap through untranslated, because 4.6 has to recognise it', async () => {
      // Somebody else's accepted booking already holds the week.
      await bookingStore.create({
        listingId: MOWER,
        renterId: 'user-first',
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
        requestExpiresAt: Time.addHours(NOW, 48),
      });

      /*
       * The availability check refuses first, which is the ordinary path — so to
       * reach the constraint at all the request has to arrive when the calendar
       * still reads free. That is the race §8.5.1 exists for, and only the db
       * test can produce it honestly. What this asserts is the *type* the service
       * lets through, by calling the store directly.
       */
      await expect(
        bookingStore.create({
          listingId: MOWER,
          renterId: ADA,
          state: 'RESERVED',
          startAt: Time.startOfLocalDay('2026-08-22'),
          endAt: Time.startOfLocalDay('2026-08-23'),
          timeZone: 'Europe/London',
          quoteId: 'quote-mine',
          categoryVersionId: 'category-version-2',
          itemCharge: gbp(1_800),
          renterFee: gbp(144),
          total: gbp(1_944),
          itemTitle: 'Petrol hedge trimmer',
          categoryName: 'Outdoor and gardening',
          requestExpiresAt: Time.addHours(NOW, 48),
        }),
      ).rejects.toBeInstanceOf(OverlappingBookingError);
    });

    it('writes nothing when it refuses', async () => {
      const quoteId = await givenAQuote();
      listings = new InMemoryListingQuoteSource();
      const withNoListing = new BookingsService(
        bookingStore,
        quoteStore,
        listings,
        availability,
        payments,
        ownership,
        { isPaymentEnabled: () => Promise.resolve(paymentsEnabled.value) },
        () => NOW,
      );

      await expect(withNoListing.request(ADA, { quoteId })).rejects.toThrow(
        RequestRefusedError,
      );

      expect(await service.find('booking-1', ADA, IN_GOOD_STANDING)).toBe(null);
    });
  });

  describe('reading a booking back', () => {
    it('gives it to the renter', async () => {
      const quoteId = await givenAQuote();
      const created = await service.request(ADA, { quoteId });

      const read = await service.find(created?.id ?? '', ADA, IN_GOOD_STANDING);

      /*
       * **A superset now, not an equal.** `request` returns a `Booking` and this
       * read returns a `BookingDetail` — the same booking plus whether the reader
       * may pay for it (5.2d). Matching on the object rather than on equality is
       * what keeps this test about *the booking comes back as it was made*.
       */
      expect(read).toMatchObject({ ...created });
      expect(read?.payability).toBeDefined();
    });

    it('gives it to the owner, who never made it', async () => {
      // §8.6 gives the owner the decision, so they must be able to read it.
      const quoteId = await givenAQuote();
      const created = await service.request(ADA, { quoteId });

      const read = await service.find(created?.id ?? '', OWNER, IN_GOOD_STANDING);

      expect(read?.id).toBe(created?.id);
    });

    it('answers null to anybody else', async () => {
      const quoteId = await givenAQuote();
      const created = await service.request(ADA, { quoteId });

      expect(
        await service.find(created?.id ?? '', 'user-stranger', IN_GOOD_STANDING),
      ).toBe(null);
    });

    it('answers null for a booking that does not exist', async () => {
      expect(await service.find('booking-nonexistent', ADA, IN_GOOD_STANDING)).toBe(
        null,
      );
    });

    /**
     * **Whether the reader may pay, so the page never has to guess (slice 5.2d).**
     *
     * The matrix itself is swept in `payability.test.ts` against the pure
     * function. What these prove is the *wiring*: that this read asks the flag at
     * all, that it asks about the right person, and that suspension arrives from
     * the caller rather than being assumed away.
     */
    describe('and saying whether they may pay for it', () => {
      /** An accepted booking is the ordinary thing a renter pays for. */
      async function givenAnAccepted(): Promise<string> {
        const quoteId = await givenAQuote();
        const booking = await service.request(ADA, { quoteId });
        if (booking === null) throw new Error('expected a booking');
        await service.accept(booking.id, OWNER);
        return booking.id;
      }

      it('lets the renter pay when it is accepted and payment is on', async () => {
        const id = await givenAnAccepted();

        const read = await service.find(id, ADA, IN_GOOD_STANDING);

        expect(read?.payability).toEqual({ payable: true });
      });

      /**
       * **The ordinary answer in production today.** `booking.payment` is off in
       * every environment until 5.2e, so this is what a real renter's page
       * actually renders — which is why it is asserted rather than assumed.
       */
      it('refuses when payment is switched off, and says nothing was charged', async () => {
        const id = await givenAnAccepted();
        paymentsEnabled.value = false;

        const read = await service.find(id, ADA, IN_GOOD_STANDING);

        expect(read?.payability.payable).toBe(false);
        expect(read?.payability.payable === false && read.payability.reason).toMatch(
          /not switched on yet/,
        );
      });

      it('tells the owner the renter pays, on the same booking', async () => {
        const id = await givenAnAccepted();

        const read = await service.find(id, OWNER, IN_GOOD_STANDING);

        expect(read?.payability.payable).toBe(false);
        expect(read?.payability.payable === false && read.payability.reason).toMatch(
          /renter pays/,
        );
      });

      /**
       * **The dead control this slice exists to remove.** `pay` is not
       * `@AllowsSuspended()` while this read is, so without the suspension check a
       * suspended renter would be shown a live button that the guard answers 403
       * to.
       */
      it('refuses a suspended renter rather than showing a button that 403s', async () => {
        const id = await givenAnAccepted();

        const read = await service.find(id, ADA, { isSuspended: true });

        expect(read?.payability.payable).toBe(false);
        expect(read?.payability.payable === false && read.payability.reason).toMatch(
          /suspended/,
        );
      });

      it('says there is nothing to pay for on a request nobody has answered', async () => {
        const quoteId = await givenAQuote();
        const created = await service.request(ADA, { quoteId });

        const read = await service.find(created?.id ?? '', ADA, IN_GOOD_STANDING);

        expect(read?.payability.payable).toBe(false);
        expect(read?.payability.payable === false && read.payability.reason).toMatch(
          /not been accepted yet/,
        );
      });

      /**
       * **The projection and the route must not tell two stories.** This is the
       * whole reason the rules were extracted to `payability.ts` — a renter who
       * reads one sentence on the page and a different one from the 422 has been
       * told the platform is confused about their booking.
       */
      it('gives the same sentence the pay route refuses with', async () => {
        const id = await givenAnAccepted();
        paymentsEnabled.value = false;

        const read = await service.find(id, ADA, IN_GOOD_STANDING);
        const refusal = await service
          .pay(id, ADA)
          .then(() => null)
          .catch((error: unknown) =>
            error instanceof RequestRefusedError ? error.refusal : null,
          );

        expect(read?.payability.payable === false && read.payability.reason).toBe(
          refusal,
        );
      });
    });
  });

  describe('the dashboards (BRD section 14, slice 4.8a)', () => {
    const BOB = 'user-bob';
    const DRILL = 'listing-drill';
    const OTHER_OWNER = 'user-other-owner';

    /** One request from `renter`, made the way one actually is. */
    async function givenARequestFrom(renter: string, listingId = MOWER) {
      const quote = await quotes.quote(listingId, renter, QUOTE_REQUEST);
      if (quote === null) throw new Error('expected a quote');
      const booking = await service.request(renter, { quoteId: quote.id });
      if (booking === null) throw new Error('expected a booking');
      return booking;
    }

    /** A second listing, owned by somebody else, to prove the scopes bite. */
    function givenASecondListing(): void {
      listings.give(mower({ id: DRILL, ownerId: OTHER_OWNER, title: 'Rotary hammer' }));
      bookingStore.givenOwner(DRILL, OTHER_OWNER);
    }

    it('gives a renter the bookings they asked for', async () => {
      const mine = await givenARequestFrom(ADA);

      const listed = await service.listForRenter(ADA);

      expect(listed.bookings.map((booking) => booking.id)).toEqual([mine.id]);
    });

    it('never gives a renter a booking somebody else made', async () => {
      await givenARequestFrom(ADA);

      const listed = await service.listForRenter(BOB);

      expect(listed.bookings).toEqual([]);
    });

    it('gives an owner every booking on their listings', async () => {
      const first = await givenARequestFrom(ADA);
      const second = await givenARequestFrom(BOB);

      const listed = await service.listForOwner(OWNER);

      expect(listed.bookings.map((booking) => booking.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    it('never gives an owner a booking on a listing that is not theirs', async () => {
      givenASecondListing();
      await givenARequestFrom(ADA, DRILL);

      const listed = await service.listForOwner(OWNER);

      expect(listed.bookings).toEqual([]);
    });

    it('reads empty for somebody who has never booked or listed anything', async () => {
      // Not a 404 and not a refusal: a collection scoped to the session always
      // exists, and an empty one is the truth.
      expect(await service.listForRenter('user-nobody')).toEqual({
        bookings: [],
        truncated: false,
      });
      expect(await service.listForOwner('user-nobody')).toEqual({
        bookings: [],
        truncated: false,
      });
    });

    it('orders newest first, breaking a same-millisecond tie by id', async () => {
      /*
       * **The fake stamps every row from one clock**, so ties are the normal case
       * here rather than the rare one — which is precisely when a list without a
       * total order returns insertion order and a test passes for the wrong
       * reason. Session 37's flake was this, one run in eight.
       */
      const first = await givenARequestFrom(ADA);
      const second = await givenARequestFrom(ADA);
      const third = await givenARequestFrom(ADA);

      const listed = await service.listForRenter(ADA);

      expect(listed.bookings.map((booking) => booking.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
    });

    it('says so when the list was cut short', async () => {
      await givenARequestFrom(ADA);
      await givenARequestFrom(ADA);
      await givenARequestFrom(ADA);

      const listed = await service.listForRenter(ADA, 2);

      expect(listed.bookings).toHaveLength(2);
      expect(listed.truncated).toBe(true);
    });

    it('does not claim a cut when the list fits exactly', async () => {
      // The case the probe exists for: a full page and a complete list are
      // otherwise indistinguishable, and the guess goes wrong for the person
      // with the most to look at.
      await givenARequestFrom(ADA);
      await givenARequestFrom(ADA);

      const listed = await service.listForRenter(ADA, 2);

      expect(listed.bookings).toHaveLength(2);
      expect(listed.truncated).toBe(false);
    });

    it('falls back rather than reaching for the maximum on a nonsense limit', async () => {
      await givenARequestFrom(ADA);

      const listed = await service.listForRenter(ADA, Number.NaN);

      expect(listed.bookings).toHaveLength(1);
    });

    it('gives the renter an inclusive total and no breakdown', async () => {
      // Section 3.4.4 wherever a price appears; the split belongs beside the
      // detail that explains it.
      const booking = await givenARequestFrom(ADA);

      const [row] = (await service.listForRenter(ADA)).bookings;

      expect(row?.total).toEqual(booking.total);
      expect(row).not.toHaveProperty('lineItems');
      expect(row).not.toHaveProperty('events');
    });

    it('gives the owner their own charge, and no total and no renter', async () => {
      /*
       * The renter's inclusive total on an owner's row reads as what they
       * receive, and section 3.4's commission arithmetic does not exist until
       * Phase 5. 4.6b settled the wording; this is the same decision on a second
       * surface.
       */
      const booking = await givenARequestFrom(ADA);

      const [row] = (await service.listForOwner(OWNER)).bookings;

      expect(row?.itemCharge).toEqual(booking.itemCharge);
      expect(row).not.toHaveProperty('total');
      expect(row).not.toHaveProperty('renterFee');
      expect(row).not.toHaveProperty('renterId');
    });

    it('shows the owner requests still waiting, unlike the decision panel', async () => {
      // `pendingRequests` answers *what must I decide on this listing*; this
      // answers *what is happening across everything I own*. A dashboard that
      // hid the pending ones would send an owner hunting listing by listing.
      const waiting = await givenARequestFrom(ADA);

      const listed = await service.listForOwner(OWNER);

      expect(listed.bookings.map((booking) => booking.state)).toEqual(['REQUESTED']);
      expect(listed.bookings[0]?.id).toBe(waiting.id);
    });

    it('keeps showing a booking after it has been answered', async () => {
      // The hole 4.8 exists to close: an accepted booking left the owner's
      // requests panel the moment it was answered and appeared nowhere else.
      const booking = await givenARequestFrom(ADA);
      await service.accept(booking.id, OWNER);

      const owner = await service.listForOwner(OWNER);
      const renter = await service.listForRenter(ADA);

      expect(owner.bookings[0]?.state).toBe('ACCEPTED');
      expect(renter.bookings[0]?.state).toBe('ACCEPTED');
    });

    it('carries the terms it was made under, not the listing as it stands', async () => {
      // Section 8.2: the copy is what lets a list render after a retitle.
      // Changing the source and re-reading is the only way to prove it is a copy.
      const booking = await givenARequestFrom(ADA);
      listings.give(mower({ title: 'Renamed since' }));

      const [row] = (await service.listForRenter(ADA)).bookings;

      expect(row?.itemTitle).toBe(booking.itemTitle);
      expect(row?.itemTitle).not.toBe('Renamed since');
    });

    it('states the last day inclusively, as the renter asked for it', async () => {
      // The column holds the exclusive bound. "The 21st to the 23rd" ends at the
      // start of the 24th, and every projection converts back.
      await givenARequestFrom(ADA);

      const [row] = (await service.listForRenter(ADA)).bookings;

      expect(row?.startDate).toBe('2026-08-21');
      expect(row?.endDate).toBe('2026-08-23');
      expect(row?.days).toBe(3);
    });
  });
});
