import { beforeEach, describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import type { RecordingLogger } from '@platform/observability/testing';
import { BookingsService } from './bookings.service.js';
import { QuotesService } from './quotes.service.js';
import { RequestExpiryService } from './request-expiry.service.js';
import {
  InMemoryAvailabilityStore,
  InMemoryBookingStore,
  InMemoryListingQuoteSource,
  InMemoryQuoteStore,
} from './testing/fakes.js';

/**
 * The expiry sweep (slice 4.7a).
 *
 * **Every booking here is made through `BookingsService`, not pushed into the
 * store.** The deadline is the thing under test, and 4.5a computes it from the
 * category's configured hours — so a test that wrote `requestExpiresAt` itself
 * would be asserting against a number it invented rather than against the one the
 * product actually stamps. It is also what makes the "48 hours" in these tests a
 * real consequence of `currentRequestExpiryHours` rather than a coincidence.
 *
 * **What this file cannot show is the race.** The real guarantee is that the state
 * predicate is evaluated inside the `UPDATE`, under the row lock; in memory there
 * is nothing between the read and the write. `prisma-booking-store.db.test.ts`
 * owns that, and says so.
 */

const MOWER = 'listing-mower';
const ADA = 'user-ada';
const BEN = 'user-ben';
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

describe('RequestExpiryService', () => {
  let bookingStore: InMemoryBookingStore;
  let logger: RecordingLogger;
  let clock: Date;
  let bookings: BookingsService;
  let expiry: RequestExpiryService;

  /**
   * A request, made the way a renter makes one.
   *
   * The dates differ per renter so two requests do not collide on the fake's
   * overlap rule — `REQUESTED` is non-blocking in the real constraint (§7.1) but
   * these are about deadlines, not about conflicts.
   */
  async function givenARequestFrom(
    renter: string,
    startDate: string,
    endDate: string,
  ): Promise<string> {
    const quote = await new QuotesService(
      quoteStore,
      listings,
      availability,
      () => clock,
    ).quote(MOWER, renter, { startDate, endDate, postcode: 'BS7 8AA' });
    if (quote === null) throw new Error('expected a quote');

    const booking = await bookings.request(renter, { quoteId: quote.id });
    if (booking === null) throw new Error('expected a booking');
    return booking.id;
  }

  let quoteStore: InMemoryQuoteStore;
  let listings: InMemoryListingQuoteSource;
  let availability: InMemoryAvailabilityStore;

  beforeEach(() => {
    clock = NOW;
    bookingStore = new InMemoryBookingStore(() => clock).givenOwner(MOWER, OWNER);
    quoteStore = new InMemoryQuoteStore();
    listings = new InMemoryListingQuoteSource().give(mower());
    availability = new InMemoryAvailabilityStore(bookingStore);
    logger = createRecordingLogger();
    bookings = new BookingsService(
      bookingStore,
      quoteStore,
      listings,
      availability,
      () => clock,
    );
    expiry = new RequestExpiryService(bookingStore, logger.logger, () => clock);
  });

  /** Move every clock this test holds forward. */
  function advanceHours(hours: number): void {
    clock = Time.addHours(clock, hours);
  }

  describe('what it expires', () => {
    it('expires a request whose deadline has passed', async () => {
      const id = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(49);
      const { expired } = await expiry.sweep();

      expect(expired.map((request) => request.id)).toEqual([id]);

      const after = await bookingStore.findForParty(id, ADA);
      expect(after?.booking.state).toBe('EXPIRED');
    });

    it('leaves a request whose deadline has not passed', async () => {
      const id = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      // One hour short of the configured 48. The boundary is the interesting part:
      // 47 must survive and 49 must not.
      advanceHours(47);
      const { expired } = await expiry.sweep();

      expect(expired).toEqual([]);

      const after = await bookingStore.findForParty(id, ADA);
      expect(after?.booking.state).toBe('REQUESTED');
    });

    it('takes the deadline from the category’s configuration, not a constant', async () => {
      // The same request against a category that allows only two hours. If the
      // sweep held a hard-coded 48 this would still be REQUESTED.
      listings.give(mower({ currentRequestExpiryHours: 2 }));
      const id = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(3);
      await expiry.sweep();

      const after = await bookingStore.findForParty(id, ADA);
      expect(after?.booking.state).toBe('EXPIRED');
    });

    it('does not touch a booking that was already answered', async () => {
      const accepted = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');
      await bookings.accept(accepted, OWNER);

      // Well past the deadline the request had before it was accepted. An
      // acceptance is not undone by a clock.
      advanceHours(72);
      const { expired } = await expiry.sweep();

      expect(expired).toEqual([]);

      const after = await bookingStore.findForParty(accepted, ADA);
      expect(after?.booking.state).toBe('ACCEPTED');
    });

    it('expires nothing twice', async () => {
      await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');
      advanceHours(49);

      const first = await expiry.sweep();
      const second = await expiry.sweep();

      expect(first.expired).toHaveLength(1);
      expect(second.expired).toEqual([]);
    });

    it('expires the longest-overdue request first', async () => {
      const older = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');
      advanceHours(5);
      const newer = await givenARequestFrom(BEN, '2026-09-10', '2026-09-12');

      advanceHours(49);
      const { expired } = await expiry.sweep();

      expect(expired.map((request) => request.id)).toEqual([older, newer]);
    });

    it('carries the renter, so Phase 6 knows who to tell', async () => {
      await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(49);
      const { expired } = await expiry.sweep();

      expect(expired[0]).toMatchObject({ renterId: ADA, listingId: MOWER });
    });
  });

  describe('the history it writes (§6.2)', () => {
    it('records the change with no actor, because nobody decided it', async () => {
      const id = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(49);
      await expiry.sweep();

      const after = await bookingStore.findForParty(id, ADA);
      expect(after?.events.at(-1)).toMatchObject({
        type: 'state-changed',
        fromState: 'REQUESTED',
        toState: 'EXPIRED',
        actorId: null,
      });
    });

    it('adds no new event type, because toState already says what happened', async () => {
      const id = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(49);
      await expiry.sweep();

      const after = await bookingStore.findForParty(id, ADA);
      /*
       * `bookings.ts` asks 4.7 to justify a new member before adding one, and the
       * answer was no: an auto-decline needed `auto-declined` because
       * `REQUESTED → DECLINED` had two possible causes; an expiry has one. This
       * pins that decision, because the tempting change is to add `'expired'`.
       */
      expect(after?.events.map((event) => event.type)).toEqual([
        'requested',
        'state-changed',
      ]);
    });

    it('leaves the history of a booking it did not touch alone', async () => {
      const kept = await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(47);
      await expiry.sweep();

      const after = await bookingStore.findForParty(kept, ADA);
      expect(after?.events).toHaveLength(1);
    });
  });

  describe('what it says about itself', () => {
    it('logs the count and the ids, and no renter or item', async () => {
      await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(49);
      await expiry.sweep();

      const [line] = logger.at('info');
      expect(line?.message).toBe('expired unanswered requests');
      expect(line?.fields).toMatchObject({ count: 1, reachedLimit: false });

      /*
       * The renter id must not be in the log. Application logs reach Loki, which
       * keeps them 14 days and has none of §10.1's erasure guarantees — and a
       * booking id is ours and meaningless alone where a user id is not.
       */
      expect(JSON.stringify(line?.fields)).not.toContain(ADA);
    });

    it('says nothing at info when there was nothing to do', async () => {
      await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(1);
      await expiry.sweep();

      // An hourly line saying "nothing happened" is how a log stops being read.
      expect(logger.at('info')).toEqual([]);
      expect(logger.at('debug')).toHaveLength(1);
    });

    it('does not warn when the batch was not filled', async () => {
      await givenARequestFrom(ADA, '2026-08-21', '2026-08-23');

      advanceHours(49);
      await expiry.sweep();

      expect(logger.at('warn')).toEqual([]);
    });
  });
});
