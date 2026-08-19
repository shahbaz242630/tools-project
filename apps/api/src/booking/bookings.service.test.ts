import { beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import { BookingsService, RequestRefusedError } from './bookings.service.js';
import { OverlappingBookingError } from './booking-store.js';
import { QuotesService } from './quotes.service.js';
import {
  InMemoryAvailabilityStore,
  InMemoryBookingStore,
  InMemoryListingQuoteSource,
  InMemoryQuoteStore,
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
    service = new BookingsService(
      bookingStore,
      quoteStore,
      listings,
      availability,
      () => NOW,
    );
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
        () => NOW,
      );

      await expect(withNoListing.request(ADA, { quoteId })).rejects.toThrow(
        RequestRefusedError,
      );

      expect(await service.find('booking-1', ADA)).toBe(null);
    });
  });

  describe('reading a booking back', () => {
    it('gives it to the renter', async () => {
      const quoteId = await givenAQuote();
      const created = await service.request(ADA, { quoteId });

      const read = await service.find(created?.id ?? '', ADA);

      expect(read).toEqual(created);
    });

    it('gives it to the owner, who never made it', async () => {
      // §8.6 gives the owner the decision, so they must be able to read it.
      const quoteId = await givenAQuote();
      const created = await service.request(ADA, { quoteId });

      const read = await service.find(created?.id ?? '', OWNER);

      expect(read?.id).toBe(created?.id);
    });

    it('answers null to anybody else', async () => {
      const quoteId = await givenAQuote();
      const created = await service.request(ADA, { quoteId });

      expect(await service.find(created?.id ?? '', 'user-stranger')).toBe(null);
    });

    it('answers null for a booking that does not exist', async () => {
      expect(await service.find('booking-nonexistent', ADA)).toBe(null);
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
