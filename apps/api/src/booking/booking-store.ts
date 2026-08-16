import type { BookingState } from '@platform/contracts';

/**
 * How bookings are read and written (slice 4.2).
 *
 * **There is no service above this yet, and that is the slice boundary.**
 * Nothing creates a booking through the product until 4.5 — this exists so the
 * database guarantee §8.5.1 calls normative can be proved against a real
 * Postgres before there is a surface that could depend on it being wrong. It is
 * the shape 3.1a used: the repository and its db tests first, the page after.
 */

/** A booking, as this module writes one. */
export interface NewBooking {
  readonly listingId: string;
  readonly renterId: string;
  readonly state: BookingState;
  readonly startAt: Date;
  readonly endAt: Date;
  /**
   * The IANA zone the hire is counted in (ADR 0003).
   *
   * **Required rather than defaulted to `Europe/London`.** A default here is a
   * caller that never had to think about it, and the one thing ADR 0003 asks of
   * every later reader is that they know a rental day is a local calendar day.
   * There is exactly one value today and stating it costs a line.
   */
  readonly timeZone: string;
}

/** A booking, as this module reads one back. */
export interface BookingRecord extends NewBooking {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Thrown when the database refuses a booking because the dates are already
 * taken (BRD §8.5.1).
 *
 * **A named error rather than a leaked driver exception**, for the reason every
 * adapter in this project translates: the caller — slice 4.6's acceptance, in
 * one transaction with the auto-decline — has to tell "somebody got there
 * first" apart from "the database is down", and those two arrive from Prisma as
 * the same shape of throw with a different code buried in it.
 *
 * **It carries no detail about the conflicting booking**, deliberately. Who
 * else holds those dates is not the caller's business and is certainly not the
 * losing renter's: §7.1 tells them their request was auto-declined and prompts
 * them to search alternatives, which needs no facts about a stranger.
 */
export class OverlappingBookingError extends Error {
  constructor(readonly listingId: string) {
    super(`Those dates are no longer available for listing ${listingId}`);
    this.name = 'OverlappingBookingError';
  }
}

export interface BookingStore {
  /**
   * Write a booking, or refuse it because the dates are taken.
   *
   * **The refusal comes from the database and nothing above it may pre-empt
   * that.** §8.5.1 names application-level check-then-insert as the anti-pattern
   * by name — it is racy under exactly the concurrency this constraint exists
   * for. A caller that "checks availability first" and then inserts has not
   * made this safer; it has made the window smaller and the bug rarer.
   *
   * Throws `OverlappingBookingError` when the period collides with a booking in
   * one of §8.5.1's nine calendar-occupying states.
   */
  create(booking: NewBooking): Promise<BookingRecord>;

  /**
   * The subset of these listings that any booking refers to.
   *
   * **This is what `catalogue/booking-references.ts` declares**, answered here.
   * It is on the store rather than on a service because there is no service in
   * this module yet and inventing one to hold a single read would be scaffolding
   * — 4.5 adds one when there is behaviour to put in it.
   */
  findBookedListings(listingIds: readonly string[]): Promise<ReadonlySet<string>>;
}
