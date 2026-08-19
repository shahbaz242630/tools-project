import { Time } from '@platform/core';
import {
  firstDayOf,
  monthOf,
  type AvailabilityBlock,
  type AvailabilityBlockRequest,
  type BookedPeriod,
  type ListingAvailability,
} from '@platform/contracts';
import type {
  AvailabilityBlockRecord,
  AvailabilityStore,
  BookedPeriodRecord,
} from './availability-store.js';
import type { ListingOwnership } from './listing-ownership.js';
import { MAX_BLOCK_DAYS, MAX_BLOCK_HORIZON_DAYS } from './limits.js';
import { periodFromLocalDates } from './local-period.js';

/**
 * The owner's calendar (BRD §8.5, slice 4.3b).
 *
 * **This service is the conversion between two ways of talking about time, and
 * almost nothing else.** An owner deals in calendar dates; the store deals in a
 * half-open pair of instants. 4.3a built everything on the storage side, and
 * what was missing was the one place that turns *"the 20th to the 22nd"* into
 * `[20 Aug 00:00 Europe/London, 23 Aug 00:00 Europe/London)` and back again.
 *
 * **Doing it once, here, is the whole safety argument.** Two conversions is how
 * a calendar and a booking path come to disagree about which day a period ends
 * — and the disagreement is invisible for seven months of the year, because in
 * winter the platform's timezone and UTC are the same thing.
 *
 * **Nothing here is audited, deliberately.** ADR 0017 makes an unaudited
 * *administrative* action a failure; this is an owner writing in their own
 * diary about their own item, which is the same category as pausing a listing —
 * and 2.8b deliberately records that against nobody.
 */
export class AvailabilityService {
  constructor(
    private readonly store: AvailabilityStore,
    /**
     * Whose listing this is, answered by Catalogue (BRD §5.1).
     *
     * **Every method here begins with it**, and the shape of the answer is what
     * makes that cheap to get right: a boolean cannot be mistaken for a listing
     * somebody forgot to check.
     */
    private readonly listings: ListingOwnership,
    /**
     * Injected so the two clock-dependent refusals below are provable without
     * waiting for a year to pass. Defaults to the real clock, as
     * `FeatureFlagsService` does, and through `Time.nowUtc()` rather than
     * `new Date()`, which is banned across this application (ADR 0003).
     */
    private readonly now: () => Date = Time.nowUtc,
  ) {}

  /**
   * One month of one listing's calendar, or null if it is not this owner's.
   *
   * **Blocks that merely touch the month are included**, which is `listBlocks`'
   * behaviour and is what the page needs: a fortnight beginning on 28 July is
   * part of what August looks like, and a calendar that only drew contained
   * periods would show the first days of the month as free while the request
   * path refused them.
   */
  async readMonth(
    listingId: string,
    ownerId: string,
    /**
     * Which month, or absent for the current one.
     *
     * **The default is resolved here rather than by the controller**, and it was
     * the other way round until an integration test caught it. The controller
     * has no clock — it would have to read the real one — so the default month
     * was the only thing in this slice that could not be pinned to a fixed date
     * in a test, and the *caller* deciding what "now" means is precisely the
     * mistake this file exists to prevent one layer further out.
     */
    month?: string,
  ): Promise<ListingAvailability | null> {
    if (!(await this.listings.isOwnedBy(listingId, ownerId))) return null;

    const resolved = month ?? monthOf(Time.toLocalDateString(this.now()));

    const from = Time.startOfLocalDay(firstDayOf(resolved));
    // The start of the next month, exclusive — the same `[)` shape as everything
    // else here, so a block starting at midnight on the 1st belongs to exactly
    // one month's window rather than to two or to neither.
    const to = Time.startOfLocalDay(firstDayOf(nextMonth(resolved)));

    /*
     * **Both layers, in one round trip each, fetched together** (slice 4.8c).
     * §8.5 names three concepts and this answers all three: what the owner
     * declared, what a booking holds, and — by their absence — what is free.
     *
     * They are two queries rather than one because they are two tables with
     * different rules about which rows count, and a `UNION` would have to encode
     * §8.5.1's nine states into a shape the caller could not tell apart
     * afterwards. Awaited together because neither depends on the other.
     */
    const [blocks, bookings] = await Promise.all([
      this.store.listBlocks(listingId, from, to),
      this.store.listBookedPeriods(listingId, from, to),
    ]);

    // The month is echoed back because the caller may not have chosen it. A page
    // that had to work out which month it was looking at would be the second
    // place this is decided.
    return {
      month: resolved,
      blocks: blocks.map(toWireBlock),
      bookings: bookings.map(toWirePeriod),
    };
  }

  /**
   * Declare a period unavailable, or null if the listing is not this owner's.
   *
   * Throws {@link BlockRefusedError} when the period itself is one we will not
   * accept — see `limits.ts` for what each bound is for.
   */
  async block(
    listingId: string,
    ownerId: string,
    request: AvailabilityBlockRequest,
  ): Promise<AvailabilityBlock | null> {
    if (!(await this.listings.isOwnedBy(listingId, ownerId))) return null;

    /*
     * **The inclusive last day becomes an exclusive bound**, which is the one
     * piece of arithmetic this service exists for. "To the 22nd" ends at the
     * start of the 23rd, so a block ending on the 22nd and a booking collected
     * on the 23rd do not overlap — which is what the `[)` in the migration's
     * trigger means and what `overlaps()` in the adapter compares.
     *
     * **It moved into `local-period.ts` in slice 4.4b**, when the quote engine
     * became a second caller. The rule is unchanged; what changed is that there
     * is still only one implementation of it.
     */
    const { startAt, endAt } = periodFromLocalDates(request.startDate, request.endDate);

    this.refuseUnacceptablePeriod(request, startAt, endAt);

    /*
     * **No overlap check against existing blocks**, and the store's docblock
     * says why: an owner who blocks a fortnight and then a week inside it has
     * said the same thing twice, and refusing the second would be a form error
     * about nothing.
     *
     * **No check against bookings either**, and that one is a decision rather
     * than an omission. Blocking dates something is already booked for is
     * redundant, not harmful — the answer to *"is this available"* is no either
     * way. What must never happen is the reverse, a booking landing on a
     * blocked period, and that is 4.5's and 4.6's to refuse.
     */
    const created = await this.store.block({
      listingId,
      startAt,
      endAt,
      reason: request.reason,
    });

    return toWireBlock(created);
  }

  /**
   * Remove a declared period.
   *
   * **False for a listing that is not this owner's *and* for a block that does
   * not exist**, collapsed on purpose so the route answers 404 to both. The two
   * are the same fact from outside: something you asked to delete is not there.
   * Distinguishing them would let somebody with a block id learn whose calendar
   * it is on.
   *
   * The ownership check is not redundant with the store's listing scope. That
   * scope stops a block being deleted through the *wrong listing*; this stops it
   * being deleted through the wrong *person*, who would otherwise only need the
   * pair of ids — both of which travel in URLs.
   */
  async unblock(listingId: string, ownerId: string, blockId: string): Promise<boolean> {
    if (!(await this.listings.isOwnedBy(listingId, ownerId))) return false;

    return this.store.unblock(blockId, listingId);
  }

  /** The three bounds in `limits.ts`, each with the sentence an owner reads. */
  private refuseUnacceptablePeriod(
    request: AvailabilityBlockRequest,
    startAt: Date,
    endAt: Date,
  ): void {
    const today = Time.toLocalDateString(this.now());

    if (request.endDate < today) {
      /*
       * **The whole period is over.** Not a typo-catcher like the two below —
       * this one is about the operation being pointless: nothing can be booked
       * for a day that has passed, so the block would change nothing while
       * appearing on the calendar as though it had.
       *
       * A block that *started* in the past and runs into the future is
       * perfectly legitimate and is accepted: an owner realising on Wednesday
       * that the mower has been away since Monday is doing the right thing.
       */
      throw new BlockRefusedError(
        'That period has already finished, so blocking it would change nothing. ' +
          'Choose dates that end today or later.',
      );
    }

    if (request.startDate > Time.addLocalDays(today, MAX_BLOCK_HORIZON_DAYS)) {
      throw new BlockRefusedError(
        'That start date is more than two years away. If you meant a date sooner ' +
          'than that, check the year.',
      );
    }

    // Measured from the exclusive end, so the count is the number of days the
    // owner actually blocked — three for the 20th to the 22nd — and it stays
    // right across a clock change, where 24-hour arithmetic would not.
    if (Time.rentalDayCount(startAt, endAt) > MAX_BLOCK_DAYS) {
      throw new BlockRefusedError(
        `A single period can cover at most ${String(MAX_BLOCK_DAYS)} days. Block a ` +
          'shorter period, or add more than one.',
      );
    }
  }
}

/**
 * A period we will not accept, with the sentence the owner is shown.
 *
 * **Carries the words rather than a code**, matching `ListingTransitionRefusedError`
 * in Catalogue: the refusal is decided here, where the rule is, and a controller
 * that invented its own wording would be a second place the rule is described —
 * which is how a message comes to contradict the check that produced it.
 */
export class BlockRefusedError extends Error {
  readonly refusal: string;

  constructor(refusal: string) {
    super(refusal);
    this.name = 'BlockRefusedError';
    this.refusal = refusal;
  }
}

/**
 * A stored period as the wire describes it — dates, never instants.
 *
 * **The inclusive last day is read from the instant *before* the exclusive
 * bound**, rather than by subtracting a day from it. The two agree for every
 * block this service writes, because it writes midnight; they stop agreeing the
 * moment anything stores a period that ends part-way through a day, and this
 * form answers *"the last day any of this period falls on"* — which is the
 * question — in both cases.
 */
function toWireBlock(record: AvailabilityBlockRecord): AvailabilityBlock {
  return {
    id: record.id,
    startDate: Time.toLocalDateString(record.startAt),
    endDate: Time.toLocalDateString(Time.fromEpochMs(record.endAt.getTime() - 1)),
    reason: record.reason,
  };
}

/**
 * A booked period as the wire describes it — dates, never instants (slice 4.8c).
 *
 * **The same inclusive-end conversion `toWireBlock` performs**, and read from the
 * instant *before* the exclusive bound rather than by subtracting a day. The two
 * agree for every booking this system writes, because a hire starts and ends at
 * midnight; they stop agreeing the moment anything stores a period ending
 * part-way through a day, and this form answers *"the last day any of this period
 * falls on"* in both cases.
 *
 * **Nothing else off the record crosses.** The store hands back three fields and
 * this hands on three: a calendar asks about time, and the money, the terms and
 * the renter are all somewhere a sentence can qualify them.
 */
function toWirePeriod(record: BookedPeriodRecord): BookedPeriod {
  return {
    id: record.id,
    startDate: Time.toLocalDateString(record.startAt),
    endDate: Time.toLocalDateString(Time.fromEpochMs(record.endAt.getTime() - 1)),
  };
}

/** The month after this one, as `YYYY-MM`. */
function nextMonth(month: string): string {
  return monthOf(Time.addLocalMonths(firstDayOf(month), 1));
}
