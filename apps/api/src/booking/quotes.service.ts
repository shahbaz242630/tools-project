import { Time } from '@platform/core';
import { QUOTE_VALIDITY_MINUTES } from '@platform/contracts';
import type { QuoteRequest, RentalQuote } from '@platform/contracts';
import {
  describePeriodRefusal,
  rentalPeriodDays,
  refusePeriod,
} from '../pricing/rental-period.js';
import {
  describeBelowMinimumBooking,
  priceRental,
  refuseBelowMinimumBooking,
} from '../pricing/rental-quote.js';
import type { AvailabilityStore, UnavailableReason } from './availability-store.js';
import type { ListingQuoteSource } from './listing-quote-source.js';
import { periodFromLocalDates } from './local-period.js';
import type { QuoteRecord, QuoteStore } from './quote-store.js';

/**
 * The platform's timezone, named once here.
 *
 * A quote stores the zone it was counted in (ADR 0003) and there is exactly one
 * value today. Taking it from `@platform/core` rather than writing the string
 * means the day a second zone exists, this is one place to change rather than a
 * literal somebody has to find.
 */
const PLATFORM_TIME_ZONE = Time.PLATFORM_TIMEZONE;

/**
 * A firm price for a period (BRD §8.5.2, slice 4.4b).
 *
 * **This service is a sequence of refusals with a price at the end**, and the
 * order is the design. Each check is cheaper or more consequential than the one
 * after it, and each has its own sentence, because "we cannot quote that" is
 * four different problems to the person reading it.
 *
 * 1. **Is there a listing a stranger could book?** Answered by Catalogue, which
 *    owns both visibility columns and the owner's declaration.
 * 2. **Is it their own item?** §7 has no state for hiring from yourself.
 * 3. **Is the period lawful?** §8.5.3's cap, via `refusePeriod`, which takes no
 *    override — an owner cannot agree to a longer hire and neither can we.
 * 4. **Is it in the past?** A price for finished dates is a price for nothing.
 * 5. **Are the dates actually free?** Both tables, one round trip, via
 *    `reasonUnavailable`.
 * 6. **Can it be priced, and is the total large enough to take?** §3.4.2's
 *    minimum booking total, enforced here for the first time.
 *
 * **The order of 3 before 5 is deliberate.** An unlawful period must be refused
 * as unlawful even if the dates also happen to be booked, because "those dates
 * are taken" invites somebody to try the same 200-day hire a week later.
 *
 * **Nothing here is audited.** ADR 0017 makes an unaudited *administrative*
 * action a failure; this is a member asking what something costs, and the record
 * of it is the quote row itself.
 */
export class QuotesService {
  constructor(
    private readonly quotes: QuoteStore,
    /** What the item costs and what its category permits, answered by Catalogue. */
    private readonly listings: ListingQuoteSource,
    /**
     * Whether the dates are free.
     *
     * **The store rather than `AvailabilityService`**, and the difference
     * matters: that service's questions are all owner-scoped — every method
     * begins by checking ownership — and a renter asking for a price owns
     * nothing. `reasonUnavailable` is the one question on the store that is not
     * about whose calendar it is.
     */
    private readonly availability: AvailabilityStore,
    /**
     * Injected so the expiry and the past-dates refusal are provable without
     * waiting for time to pass. Through `Time.nowUtc` rather than `new Date()`,
     * which is banned across this application (ADR 0003).
     */
    private readonly now: () => Date = Time.nowUtc,
  ) {}

  /**
   * Price a period, or refuse it with a sentence.
   *
   * Resolves to null when there is no listing this person could book — the
   * caller answers 404, and cannot tell the four cases apart.
   *
   * Throws {@link QuoteRefusedError} for a period we will not price. That is a
   * 422 rather than a 404: the listing exists and the request is well formed, and
   * what is wrong is the period or the total.
   */
  async quote(
    listingId: string,
    renterId: string,
    request: QuoteRequest,
  ): Promise<RentalQuote | null> {
    const listing = await this.listings.findQuotable(listingId);
    if (listing === null) return null;

    if (listing.ownerId === renterId) {
      /*
       * **A refusal rather than a 404**, which is the one place this service
       * departs from "a renter learns nothing they did not already know". They
       * plainly know the listing exists — it is theirs — so hiding behind a 404
       * would only be confusing. §7 has no state for a hire from yourself, and a
       * booking whose two parties are one person would put them on both sides of
       * a payout.
       */
      throw new QuoteRefusedError(
        'This is your own listing, so there is nothing to quote. Ask somebody else ' +
          'to book it, or use your calendar to block the dates.',
      );
    }

    const { startAt, endAt } = periodFromLocalDates(request.startDate, request.endDate);

    const unlawful = refusePeriod(
      startAt,
      endAt,
      PLATFORM_TIME_ZONE,
      listing.currentMaximumRentalDays,
    );
    if (unlawful !== null) throw new QuoteRefusedError(describePeriodRefusal(unlawful));

    this.refusePastPeriod(request);

    const unavailable = await this.availability.reasonUnavailable(
      listing.id,
      startAt,
      endAt,
    );
    if (unavailable !== null)
      throw new QuoteRefusedError(describeUnavailable(unavailable));

    const days = rentalPeriodDays(startAt, endAt, PLATFORM_TIME_ZONE);
    const priced = priceRental(
      days,
      Time.weekdayOf(request.startDate),
      listing.rates,
      listing.currentFeePolicy,
    );

    if (priced === null) {
      /*
       * **Unreachable through the product, and refused rather than assumed
       * unreachable.** Slice 2.8 will not publish a listing without a daily rate
       * and `findQuotable` only answers about published listings — so this is the
       * belt to that braces. A quote of £0 is the failure it prevents.
       */
      throw new QuoteRefusedError(
        'This item has no price set, so we cannot quote it yet. Its owner needs to ' +
          'add a daily rate.',
      );
    }

    const tooSmall = refuseBelowMinimumBooking(priced.total, listing.currentFeePolicy);
    if (tooSmall !== null)
      throw new QuoteRefusedError(describeBelowMinimumBooking(tooSmall));

    const created = await this.quotes.create({
      listingId: listing.id,
      renterId,
      startAt,
      endAt,
      timeZone: PLATFORM_TIME_ZONE,
      renterPostcode: request.postcode,
      itemCharge: priced.itemCharge,
      renterFee: priced.renterFee,
      total: priced.total,
      minimumFeeApplied: priced.minimumFeeApplied,
      lineItems: priced.lineItems,
      categoryVersionId: listing.currentCategoryVersionId,
      expiresAt: this.expiryFromNow(),
    });

    return toWireQuote(created);
  }

  /**
   * One of this renter's quotes, or null for both "no such quote" and "not
   * yours" — see the store.
   *
   * **Expired quotes are returned, not hidden.** A renter who left the page open
   * is owed *"this price has expired"* rather than *"no such thing"*, and 4.5 is
   * what refuses to build a booking on one. The wire projection carries
   * `expiresAt` so the difference is visible to whatever renders it.
   */
  async find(id: string, renterId: string): Promise<RentalQuote | null> {
    const quote = await this.quotes.findForRenter(id, renterId);
    if (quote === null) return null;

    return toWireQuote(quote);
  }

  /**
   * Erase every quote this person was given (§10.1).
   *
   * **Implements `PersonalDataEraser` for the booking module, which is its first
   * personal-data obligation.** A quote holds the renter's postcode, and the
   * `ON DELETE CASCADE` on `quotes.renterId` does *not* discharge it: accounts
   * are soft-deleted with a tombstoned email (ADR 0018), so the `users` row
   * survives and the cascade never fires.
   *
   * **No audit entry, unlike the profile and listing erasers.** Those record what
   * was removed because the removal is of something the person created and others
   * may have seen. A quote is a price we offered; the deletion request itself is
   * already audited by `AccountErasure`, and an entry per expired quotation would
   * bury that trail in noise.
   */
  async eraseFor(renterId: string): Promise<number> {
    return this.quotes.deleteAllForRenter(renterId);
  }

  /**
   * Refuse a period that has already finished.
   *
   * **The same rule as the calendar's, and deliberately not shared with it.**
   * `AvailabilityService` refuses a *block* whose last day has passed because
   * blocking it would change nothing; this refuses a *hire* in the past because
   * there is nothing to hire. The sentences differ because the readers differ, and
   * a shared helper would have to be told which one it was serving.
   *
   * **A hire that starts today is fine.** Somebody collecting a mower this
   * afternoon is the ordinary case, not an edge one.
   */
  private refusePastPeriod(request: QuoteRequest): void {
    const today = Time.toLocalDateString(this.now());

    if (request.startDate < today) {
      throw new QuoteRefusedError(
        'That hire starts in the past. Choose a collection date from today onwards.',
      );
    }
  }

  private expiryFromNow(): Date {
    return Time.fromEpochMs(this.now().getTime() + QUOTE_VALIDITY_MINUTES * 60_000);
  }
}

/**
 * A period we will not price, with the sentence the renter is shown.
 *
 * **Carries the words rather than a code**, matching `BlockRefusedError` beside
 * it and `ListingTransitionRefusedError` in Catalogue: the refusal is decided
 * where the rule is, and a controller that invented its own wording would be a
 * second place the rule is described — which is how a message comes to
 * contradict the check that produced it.
 */
export class QuoteRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = 'QuoteRefusedError';
  }
}

/**
 * Why the dates are not free, as a renter may be told it.
 *
 * **It says *that* the period is unavailable and never *why*.** An owner's block
 * carries their own note — "away until the 14th", "lent to my brother" — and that
 * is a sentence about somebody's house being empty. A booking is a stranger's
 * business. So both reasons produce the same words, and the vocabulary is
 * switched on exhaustively so a third reason cannot quietly inherit a sentence
 * written for these two.
 */
function describeUnavailable(reason: UnavailableReason): string {
  switch (reason) {
    case 'blocked':
    case 'booked':
      return (
        'Those dates are not available for this item. The calendar on the listing ' +
        'shows what is free.'
      );
  }
}

/**
 * A stored quote as the wire projection.
 *
 * **The dates are converted back to calendar dates rather than carried as
 * instants**, which is 4.3b's rule and the reason `rentalQuoteSchema` is a
 * `strictObject`: an instant on a projection is one a page will render in the
 * device's timezone.
 *
 * **Both paths read the stored instants, including the one that has the renter's
 * own strings to hand.** Echoing back what was submitted would hide a conversion
 * bug precisely on the path where it would be introduced; deriving them means
 * the create response is the same projection a later read produces, and a test
 * can assert they agree.
 */
function toWireQuote(quote: QuoteRecord): RentalQuote {
  return {
    id: quote.id,
    listingId: quote.listingId,
    startDate: Time.toLocalDateString(quote.startAt),
    /*
     * **Back to an inclusive last day.** The column is exclusive, so the day the
     * renter asked for is the one before it — the mirror of the conversion in
     * `local-period.ts`, and the reason that function's docblock explains the
     * bound rather than leaving it to be inferred here.
     */
    endDate: Time.addLocalDays(Time.toLocalDateString(quote.endAt), -1),
    days: rentalPeriodDays(quote.startAt, quote.endAt, quote.timeZone),
    postcode: quote.renterPostcode,
    lineItems: [...quote.lineItems],
    itemCharge: quote.itemCharge,
    renterFee: quote.renterFee,
    total: quote.total,
    minimumFeeApplied: quote.minimumFeeApplied,
    expiresAt: Time.toIsoUtc(quote.expiresAt),
  };
}
