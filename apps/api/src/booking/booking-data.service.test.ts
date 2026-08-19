import { beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import { BookingDataService, EXPORTED_BOOKING_LIMIT } from './booking-data.service.js';
import { BookingsService } from './bookings.service.js';
import { QuotesService } from './quotes.service.js';
import {
  InMemoryAvailabilityStore,
  InMemoryBookingStore,
  InMemoryListingQuoteSource,
  InMemoryQuoteStore,
} from './testing/fakes.js';

/**
 * Booking's contribution to a data export (BRD §10.1, slice 4.8d).
 *
 * **The property this file exists to pin is that the export mirrors the
 * eraser.** 4.4b gave the module a `PersonalDataEraser` and no
 * `PersonalDataSource`, so a renter's postcode was deletable on request and
 * absent from the answer to *what do you hold about me* — the one direction of
 * the pair that fails silently, because nothing errors when a section is simply
 * not there.
 *
 * The second subject is the counterparty. Three arrays go out and only two of
 * them are the reader's own; the third is about their listings, and it must carry
 * nothing about the person on the other side.
 */

const ADA = 'user-ada';
const BOB = 'user-bob';
const OWNER = 'user-owner';
const MOWER = 'listing-mower';

const NOW = Time.fromIsoUtc('2026-08-20T09:00:00.000Z');

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

const rates: ListingRateCard = { daily: gbp(1_800), weekend: null, weekly: gbp(9_000) };

const policy: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_600,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: gbp(1_000),
  minimumPlatformFee: gbp(100),
};

const listing = {
  id: MOWER,
  ownerId: OWNER,
  title: 'Petrol hedge trimmer',
  categoryName: 'Outdoor and gardening',
  rates,
  currentFeePolicy: policy,
  currentMaximumRentalDays: 88,
  currentRequestExpiryHours: 48,
  currentCategoryVersionId: 'category-version-2',
};

describe('BookingDataService', () => {
  let bookingStore: InMemoryBookingStore;
  let quoteStore: InMemoryQuoteStore;
  let quotes: QuotesService;
  let bookings: BookingsService;
  let exporter: BookingDataService;

  beforeEach(() => {
    bookingStore = new InMemoryBookingStore(() => NOW).givenOwner(MOWER, OWNER);
    quoteStore = new InMemoryQuoteStore();
    const listings = new InMemoryListingQuoteSource().give(listing);
    const availability = new InMemoryAvailabilityStore(bookingStore);
    quotes = new QuotesService(quoteStore, listings, availability, () => NOW);
    bookings = new BookingsService(
      bookingStore,
      quoteStore,
      listings,
      availability,
      () => NOW,
    );
    exporter = new BookingDataService(bookingStore, quoteStore);
  });

  /** A quote for the mower, priced the way a renter gets one. */
  async function aQuote(renter: string, postcode = 'BS7 8AA'): Promise<string> {
    const quote = await quotes.quote(MOWER, renter, {
      startDate: '2026-08-21',
      endDate: '2026-08-23',
      postcode,
    });
    if (quote === null) throw new Error('expected a quote');
    return quote.id;
  }

  /**
   * A booking, made the way one actually is.
   *
   * **The fake has to be told the quote is now booked**, because `InMemoryQuote
   * Store` holds no bookings and its docblock refuses to infer it — a double that
   * decided that rule would be deciding what the real query decides. So the tests
   * below prove the *service* honours the distinction between a booked quote and
   * an unbooked one; that the export's predicate and the eraser's actually agree
   * is `prisma-quote-store.db.test.ts`'s subject, and only it can show that.
   */
  async function aBooking(renter: string): Promise<string> {
    const quoteId = await aQuote(renter);
    const booking = await bookings.request(renter, { quoteId });
    if (booking === null) throw new Error('expected a booking');
    quoteStore.bookedQuoteIds.add(quoteId);
    return booking.id;
  }

  describe('what a renter hired', () => {
    it('carries the postcode, which is why this section exists', async () => {
      /*
       * The gap 4.4b left open: `quotes.renterPostcode` was erasable and appeared
       * in no export. A booked quote is *kept* on erasure — the terms belong to
       * the counterparty too — so its postcode is retained data and Article 15
       * requires it to be disclosable.
       */
      await aBooking(ADA);

      const section = await exporter.exportFor(ADA);

      expect(section.hires).toHaveLength(1);
      expect(section.hires[0]?.collectionPostcode).toBe('BS7 8AA');
    });

    it('carries the terms the booking kept, not a join through the listing', async () => {
      // §8.2. A hire has to stay legible in a file opened years later, after the
      // item has been retitled or erased.
      await aBooking(ADA);

      const [hire] = (await exporter.exportFor(ADA)).hires;

      expect(hire?.itemTitle).toBe('Petrol hedge trimmer');
      expect(hire?.categoryName).toBe('Outdoor and gardening');
      expect(hire?.total).toEqual(gbp(5_832));
    });

    it('states the last day inclusively', async () => {
      await aBooking(ADA);

      const [hire] = (await exporter.exportFor(ADA)).hires;

      expect(hire?.startDate).toBe('2026-08-21');
      expect(hire?.endDate).toBe('2026-08-23');
    });

    it('never carries somebody else’s hire', async () => {
      await aBooking(ADA);

      expect((await exporter.exportFor(BOB)).hires).toEqual([]);
    });
  });

  describe('what was booked on their listings', () => {
    it('is a record about the owner too', async () => {
      // A file answering *what do you hold about me* that showed the hires
      // somebody made and none of the bookings on their own drill would be an
      // incomplete answer to the question §10.1 makes a legal one.
      await aBooking(ADA);

      const section = await exporter.exportFor(OWNER);

      expect(section.lettings).toHaveLength(1);
      expect(section.lettings[0]?.itemTitle).toBe('Petrol hedge trimmer');
    });

    it('carries nothing about the renter', async () => {
      /*
       * **The counterparty rule, and the reason this is a separate shape rather
       * than the hires array with a flag.** The renter's address is not the
       * owner's data, and §8.4.1's posture is that identity arrives with
       * commitment.
       */
      await aBooking(ADA);

      const [letting] = (await exporter.exportFor(OWNER)).lettings;

      expect(letting).not.toHaveProperty('collectionPostcode');
      expect(letting).not.toHaveProperty('renterId');
      expect(letting).not.toHaveProperty('renterPostcode');
    });

    it('states the owner’s own charge and no payout', async () => {
      // §3.4's commission arithmetic is Phase 5. A figure labelled as what they
      // received would be false in a document somebody may rely on.
      await aBooking(ADA);

      const [letting] = (await exporter.exportFor(OWNER)).lettings;

      expect(letting?.itemCharge).toEqual(gbp(5_400));
      expect(letting).not.toHaveProperty('total');
    });

    it('is empty for somebody who has listed nothing', async () => {
      await aBooking(ADA);

      expect((await exporter.exportFor(ADA)).lettings).toEqual([]);
    });
  });

  describe('the quotes that became nothing', () => {
    it('carries a quote nobody booked, with its postcode', async () => {
      await aQuote(ADA, 'BS1 4DJ');

      const section = await exporter.exportFor(ADA);

      expect(section.quotes).toHaveLength(1);
      expect(section.quotes[0]?.collectionPostcode).toBe('BS1 4DJ');
    });

    it('loses exactly what the eraser takes, and keeps the rest', async () => {
      /*
       * **What appears here is what disappears on deletion.** §10.1 requires the
       * deletion workflow to explain what survives, and this is the half that
       * does not: a booked quote is kept because the terms belong to the
       * counterparty, and it is represented by its hire instead.
       *
       * Asserted by *running* the eraser rather than by restating its predicate.
       * **That the two predicates agree is not provable here** — this store is
       * told which quotes are booked — and is pinned against real Postgres in
       * `prisma-quote-store.db.test.ts`.
       */
      await aBooking(ADA);
      await aQuote(ADA);

      const before = await exporter.exportFor(ADA);
      expect(before.quotes).toHaveLength(1);
      expect(before.hires).toHaveLength(1);

      const erased = await quotes.eraseFor(ADA);

      expect(erased).toBe(1);
      const after = await exporter.exportFor(ADA);
      expect(after.quotes).toEqual([]);
      // The hire survives, and so does its postcode.
      expect(after.hires).toHaveLength(1);
      expect(after.hires[0]?.collectionPostcode).toBe('BS7 8AA');
    });

    it('does not list a quote twice as a quote and as a hire', async () => {
      // Listing it in both places would make a reader wonder which was
      // authoritative.
      await aBooking(ADA);

      const section = await exporter.exportFor(ADA);

      expect(section.quotes).toEqual([]);
      expect(section.hires).toHaveLength(1);
    });

    it('never carries somebody else’s quote', async () => {
      await aQuote(ADA);

      expect((await exporter.exportFor(BOB)).quotes).toEqual([]);
    });
  });

  describe('the bound', () => {
    it('says nothing was cut when nothing was', async () => {
      await aBooking(ADA);

      expect((await exporter.exportFor(ADA)).truncated).toBe(false);
    });

    it('is set far above anybody real', async () => {
      // ADR 0035: a guardrail on a legal artefact rather than a page size, so
      // `truncated` is false for everybody until somebody is extraordinary.
      expect(EXPORTED_BOOKING_LIMIT).toBeGreaterThanOrEqual(500);
    });

    it('reads an empty section for somebody with nothing at all', async () => {
      // Not null: "you have no bookings" and "we hold no booking data about you"
      // are the same statement, and two ways to say it is how a reader comes to
      // treat them differently.
      expect(await exporter.exportFor('user-nobody')).toEqual({
        hires: [],
        lettings: [],
        quotes: [],
        truncated: false,
      });
    });
  });
});
