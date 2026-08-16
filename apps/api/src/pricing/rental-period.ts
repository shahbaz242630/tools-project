import { Time } from '@platform/core';
import { MAX_MAXIMUM_RENTAL_DAYS } from '@platform/contracts';

/**
 * How long a hire is, and whether it is allowed to be (BRD §8.5.3, slice 4.4a).
 *
 * **Pure, like §7's state machine in 4.1, and for the same reason.** The rule
 * exists before there is a booking it could mispricify, so no later slice has a
 * moment where putting the duration arithmetic in a handler is the easy path.
 * Nothing here reads a database, a clock or a request.
 *
 * **This module owns duration; it does not own price.** What a period *costs*
 * is 4.4b, and it depends on a decision that is not engineering's — how a
 * weekly rate interpolates across a period nobody has a rate for. Splitting
 * them means the legal bound ships without waiting on a commercial answer.
 */

/**
 * A hire's length in **local calendar days**, counted the way equipment hire is
 * priced.
 *
 * Collect on the 27th and return on the 3rd is 7 days. A same-day hire is
 * **one** day, never zero — you cannot rent a thing for no time.
 *
 * **Delegated to `Time.rentalDayCount` rather than reimplemented**, which is
 * ADR 0003's whole point: a rental day is a local calendar day, so a hire that
 * spans a BST transition is 23 or 25 hours long and must still count as one
 * day. Anything computing `(end - start) / 86_400_000` is wrong twice a year, in
 * opposite directions, and only for the people it happens to.
 *
 * The timezone is the booking's own (`bookings.timeZone`), not the platform
 * default, because ADR 0003 stores it per booking precisely so that a rental
 * counted today can still be recounted the same way in five years.
 */
export function rentalPeriodDays(startAt: Date, endAt: Date, timeZone: string): number {
  return Time.rentalDayCount(startAt, endAt, timeZone);
}

/**
 * Why a period cannot be hired — or `null`, meaning it can.
 *
 * A reason rather than a boolean, matching `UnavailableReason` next door in
 * Booking: the caller has to *say* something, and "too long" and "ends before it
 * starts" are different sentences to different people.
 */
export type PeriodRefusal =
  /** The end is not after the start. A quote for it would be a quote for nothing. */
  | { readonly reason: 'inverted' }
  /**
   * Longer than the category permits (§8.5.3).
   *
   * Carries both numbers because the message has to name them — *"at most 88
   * days"* is actionable and *"too long"* is not.
   */
  | {
      readonly reason: 'over-maximum';
      readonly days: number;
      readonly maximumDays: number;
    };

/**
 * Whether this period may be hired at all.
 *
 * **The cap is absolute and this function takes no override**, which is §8.5.3
 * in its own words: the extension flow *"must reject any extension that would
 * carry cumulative duration past the cap"* and the cap is *"unoverridable by
 * approval"*. An owner cannot agree to a longer hire, an administrator cannot
 * approve one, and there is deliberately no argument here through which either
 * could. A regulated activity is not something two consenting parties can opt
 * into on our behalf.
 *
 * **`maximumDays` is the category's, passed in rather than read.** This module
 * has no store — the caller holds the listing and its pinned category version
 * already (see `daily-price.ts` for the same arrangement and its reasoning), and
 * the *pinned* version is the one that matters: a booking is judged against the
 * cap it was made under.
 *
 * **The ceiling is re-checked here even though the contract validates it.**
 * `maximumRentalDaysSchema` refuses anything above 88 at the boundary, so a
 * value above it should be impossible — and this is the last place before a
 * period is judged compliant, reached by every caller including ones that got
 * their configuration from a database row written before that schema existed. A
 * legal bound is worth asserting twice.
 */
export function refusePeriod(
  startAt: Date,
  endAt: Date,
  timeZone: string,
  maximumDays: number,
): PeriodRefusal | null {
  if (endAt.getTime() <= startAt.getTime()) return { reason: 'inverted' };

  const days = rentalPeriodDays(startAt, endAt, timeZone);
  // The lower of the two, so a stored value above the statutory ceiling cannot
  // widen the bound — it can only ever be narrowed by a category's own setting.
  const permitted = Math.min(maximumDays, MAX_MAXIMUM_RENTAL_DAYS);

  if (days > permitted) {
    return { reason: 'over-maximum', days, maximumDays: permitted };
  }

  return null;
}

/**
 * The refusal as the sentence a person reads.
 *
 * **Here rather than in a controller or a page**, so the two surfaces that will
 * render it — 4.4b's quote and 4.5's request — cannot come to describe the same
 * legal bound differently. It is the treatment `BookingRefusedError` gets in
 * Booking and `ListingTransitionRefusedError` gets in Catalogue.
 *
 * The wording explains rather than merely refuses. Somebody who asked for a
 * hundred days is not doing anything unreasonable, and "the law does not let us"
 * is both true and the only version of this that does not read as an arbitrary
 * limit somebody could argue with.
 */
export function describePeriodRefusal(refusal: PeriodRefusal): string {
  if (refusal.reason === 'inverted') {
    return 'Those dates do not make a hire — the return has to come after the collection.';
  }

  return (
    `That is ${String(refusal.days)} days, and the longest hire we can arrange for ` +
    `this kind of item is ${String(refusal.maximumDays)}. Longer hires are ` +
    'regulated consumer credit, which we are not authorised to arrange. Shorten ' +
    'the dates, or book again when this hire ends.'
  );
}
