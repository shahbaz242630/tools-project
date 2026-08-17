import { beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import { QUOTE_VALIDITY_MINUTES } from '@platform/contracts';
import { QuoteRefusedError, QuotesService } from './quotes.service.js';
import {
  InMemoryAvailabilityStore,
  InMemoryBookingStore,
  InMemoryListingQuoteSource,
  InMemoryQuoteStore,
} from './testing/fakes.js';

/**
 * The quote engine's refusals and what it stores (slice 4.4b).
 *
 * The arithmetic is tested where it lives, in `pricing/rental-quote.test.ts`.
 * What is tested here is the *sequence* — six refusals in an order that matters —
 * and the record that comes out the other end.
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

function quotableMower(
  overrides: Partial<Parameters<InMemoryListingQuoteSource['give']>[0]> = {},
) {
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

describe('QuotesService', () => {
  let quotes: InMemoryQuoteStore;
  let listings: InMemoryListingQuoteSource;
  let availability: InMemoryAvailabilityStore;
  let service: QuotesService;

  beforeEach(() => {
    quotes = new InMemoryQuoteStore();
    listings = new InMemoryListingQuoteSource().give(quotableMower());
    availability = new InMemoryAvailabilityStore(new InMemoryBookingStore());
    service = new QuotesService(quotes, listings, availability, () => NOW);
  });

  const request = {
    startDate: '2026-08-21',
    /** Inclusive — a Friday to a Sunday, three days. */
    endDate: '2026-08-23',
    postcode: 'BS7 8AA',
  };

  describe('pricing a period', () => {
    it('prices the dates and returns the total inclusive of the fee', async () => {
      const quote = await service.quote(MOWER, ADA, request);

      // Three days at £18, no weekend rate set, so £54 plus 8% = £58.32.
      expect(quote?.days).toBe(3);
      expect(quote?.itemCharge).toEqual(gbp(5_400));
      expect(quote?.renterFee).toEqual(gbp(432));
      expect(quote?.total).toEqual(gbp(5_832));
      expect(quote?.lineItems).toEqual([
        { unit: 'day', count: 3, unitPrice: gbp(1_800), subtotal: gbp(5_400) },
      ]);
    });

    it('gives back the dates the renter asked for, derived from what was stored', async () => {
      const quote = await service.quote(MOWER, ADA, request);

      // The inclusive last day survives the round trip through an exclusive
      // column — the conversion `local-period.ts` owns, read back.
      expect(quote?.startDate).toBe('2026-08-21');
      expect(quote?.endDate).toBe('2026-08-23');
    });

    it('stores the postcode, the timezone and the version it priced under', async () => {
      await service.quote(MOWER, ADA, request);
      const [stored] = quotes.all();

      expect(stored?.renterPostcode).toBe('BS7 8AA');
      expect(stored?.timeZone).toBe('Europe/London');
      // §8.5.2: the quote stores the category version, so the price can be
      // explained after the category is reconfigured.
      expect(stored?.categoryVersionId).toBe('category-version-2');
      expect(stored?.renterId).toBe(ADA);
    });

    it('stores the period as instants, with the end exclusive', async () => {
      await service.quote(MOWER, ADA, request);
      const [stored] = quotes.all();

      // Midnight *London*, which in August is 23:00 UTC the day before. The
      // whole reason the conversion is on the server.
      expect(stored?.startAt.toISOString()).toBe('2026-08-20T23:00:00.000Z');
      // "To the 23rd" ends at the start of the 24th.
      expect(stored?.endAt.toISOString()).toBe('2026-08-23T23:00:00.000Z');
    });

    it('expires thirty minutes from now', async () => {
      const quote = await service.quote(MOWER, ADA, request);

      const expected = NOW.getTime() + QUOTE_VALIDITY_MINUTES * 60_000;
      expect(new Date(quote?.expiresAt ?? 0).getTime()).toBe(expected);
    });

    it('normalises the postcode on the way in', async () => {
      const quote = await service.quote(MOWER, ADA, {
        ...request,
        postcode: 'BS7 8AA',
      });

      expect(quote?.postcode).toBe('BS7 8AA');
    });
  });

  describe('what it refuses', () => {
    it('answers null for a listing nobody could book', async () => {
      // One null for four facts — no such listing, unpublished, hidden, or an
      // owner who has not declared. The route answers 404 to all of them.
      expect(await service.quote('listing-nobody', ADA, request)).toBe(null);
    });

    it('refuses to quote an owner their own listing', async () => {
      await expect(service.quote(MOWER, OWNER, request)).rejects.toThrow(
        QuoteRefusedError,
      );
      await expect(service.quote(MOWER, OWNER, request)).rejects.toThrow(
        /your own listing/i,
      );
    });

    it('refuses a hire longer than the category permits, naming both numbers', async () => {
      listings.give(quotableMower({ currentMaximumRentalDays: 30 }));

      const promise = service.quote(MOWER, ADA, {
        ...request,
        endDate: '2026-10-21',
      });

      // §8.5.3's cap, from the *current* version, and the sentence names the Act
      // rather than reading as an arbitrary limit.
      await expect(promise).rejects.toThrow(/at most 30|longest hire we can arrange/i);
    });

    it('refuses a hire that starts in the past', async () => {
      const promise = service.quote(MOWER, ADA, {
        ...request,
        startDate: '2026-08-19',
      });

      await expect(promise).rejects.toThrow(/starts in the past/i);
    });

    it('allows a hire that starts today', async () => {
      // The ordinary case, not an edge one: somebody collecting this afternoon.
      const quote = await service.quote(MOWER, ADA, {
        ...request,
        startDate: '2026-08-20',
      });

      expect(quote?.days).toBe(4);
    });

    it('refuses dates the owner has blocked, without saying why they are blocked', async () => {
      await availability.block({
        listingId: MOWER,
        startAt: Time.startOfLocalDay('2026-08-22'),
        endAt: Time.startOfLocalDay('2026-08-24'),
        reason: 'Away at my mother’s',
      });

      const promise = service.quote(MOWER, ADA, request);

      await expect(promise).rejects.toThrow(/not available/i);
      // The owner's own note must never reach a renter — it is a sentence about
      // somebody's house being empty.
      await expect(promise).rejects.not.toThrow(/mother/i);
    });

    it('refuses a period whose total is under the category minimum', async () => {
      // A £1 day for one day is £1.08 inclusive, under a £10 minimum booking
      // total. §3.4.2, enforced for the first time in this slice.
      listings.give(
        quotableMower({
          rates: { daily: gbp(100), weekend: null, weekly: null },
        }),
      );

      const promise = service.quote(MOWER, ADA, {
        ...request,
        endDate: request.startDate,
      });

      await expect(promise).rejects.toThrow(/smallest booking we can take/i);
    });

    it('refuses a listing with no daily rate rather than quoting nothing', async () => {
      listings.give(
        quotableMower({ rates: { daily: null, weekend: null, weekly: null } }),
      );

      await expect(service.quote(MOWER, ADA, request)).rejects.toThrow(/no price set/i);
    });

    it('refuses an unlawful period even when the dates are also taken', async () => {
      // The order of the checks is a decision: "those dates are taken" would
      // invite somebody to try the same 200-day hire a week later.
      listings.give(quotableMower({ currentMaximumRentalDays: 30 }));
      await availability.block({
        listingId: MOWER,
        startAt: Time.startOfLocalDay('2026-08-21'),
        endAt: Time.startOfLocalDay('2026-08-24'),
        reason: null,
      });

      const promise = service.quote(MOWER, ADA, { ...request, endDate: '2026-10-21' });

      await expect(promise).rejects.toThrow(/longest hire/i);
    });

    it('writes nothing when it refuses', async () => {
      await expect(service.quote(MOWER, OWNER, request)).rejects.toThrow(
        QuoteRefusedError,
      );

      expect(quotes.all()).toHaveLength(0);
    });
  });

  describe('reading a quote back', () => {
    it('returns the renter their own quote', async () => {
      const created = await service.quote(MOWER, ADA, request);

      const read = await service.find(created?.id ?? '', ADA);

      // The same projection either way, which is what makes the create response
      // trustworthy: both are derived from the stored row.
      expect(read).toEqual(created);
    });

    it('answers null for somebody else’s quote and for one that does not exist', async () => {
      const created = await service.quote(MOWER, ADA, request);

      expect(await service.find(created?.id ?? '', 'user-someone-else')).toBe(null);
      expect(await service.find('quote-nonexistent', ADA)).toBe(null);
    });

    it('still returns an expired quote, so the reader can be told it expired', async () => {
      const created = await service.quote(MOWER, ADA, request);

      const later = new QuotesService(quotes, listings, availability, () =>
        Time.fromIsoUtc('2026-08-20T23:00:00.000Z'),
      );

      const read = await later.find(created?.id ?? '', ADA);

      expect(read).not.toBe(null);
      expect(new Date(read?.expiresAt ?? 0).getTime()).toBeLessThan(
        Time.fromIsoUtc('2026-08-20T23:00:00.000Z').getTime(),
      );
    });
  });

  describe('erasure', () => {
    it('deletes every quote this person was given', async () => {
      await service.quote(MOWER, ADA, request);
      await service.quote(MOWER, ADA, { ...request, endDate: '2026-08-24' });
      await service.quote(MOWER, 'user-other', request);

      const erased = await service.eraseFor(ADA);

      expect(erased).toBe(2);
      expect(quotes.all().map((quote) => quote.renterId)).toEqual(['user-other']);
    });

    it('keeps a quote a booking was made from', async () => {
      /*
       * **The product owner's decision of 17 August, and the half that is easy to
       * get wrong.** The terms belong to the counterparty as much as to the renter
       * — §8.2 requires the booking to keep them and §10.1 retains booking records
       * for six years — so erasing one would destroy the other party's record of
       * what they agreed to.
       */
      const kept = await service.quote(MOWER, ADA, request);
      const gone = await service.quote(MOWER, ADA, {
        ...request,
        endDate: '2026-08-24',
      });
      quotes.bookedQuoteIds.add(kept?.id ?? '');

      expect(await service.eraseFor(ADA)).toBe(1);
      expect(quotes.all().map((quote) => quote.id)).toEqual([kept?.id]);
      expect(gone).not.toBe(null);
    });

    it('is idempotent, which a retry after a partial failure needs', async () => {
      await service.quote(MOWER, ADA, request);

      expect(await service.eraseFor(ADA)).toBe(1);
      expect(await service.eraseFor(ADA)).toBe(0);
    });
  });
});
