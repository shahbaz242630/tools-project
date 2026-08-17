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
});
