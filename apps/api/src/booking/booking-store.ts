import type { MoneyValue } from '@platform/core';
import type {
  BookingEventType,
  BookingState,
  QuoteLineItem,
} from '@platform/contracts';

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
   * The quote this was made from, and the configuration version it was priced
   * under (slice 4.5a).
   *
   * **Both required, so a booking with no provable price is unrepresentable.**
   * There is one way to make a booking and it starts with a figure somebody was
   * shown — which is §3.4.4's point, and the reason there is no overload of this
   * type that omits them.
   */
  readonly quoteId: string;
  readonly categoryVersionId: string;
  /**
   * The terms, copied at the moment of booking rather than joined later (§8.2,
   * and the product owner's *"if the booking is done, it should show in history,
   * all details"*).
   *
   * The store takes them rather than reading them off the quote itself, because
   * a repository that fetched a row to copy from it would be deciding what the
   * booking's terms are — and that is the service's decision. See
   * `bookings.service.ts`, where they come off the quote in one place.
   */
  readonly itemCharge: MoneyValue;
  readonly renterFee: MoneyValue;
  readonly total: MoneyValue;
  readonly itemTitle: string;
  readonly categoryName: string;
  /** When an unanswered request expires (§8.6), computed from the category. */
  readonly requestExpiresAt: Date;
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
 * One entry in a booking's history (BRD §6.2, slice 4.5a).
 *
 * **`fromState` is null on the first event and only there.** A booking's first
 * event has nothing to come from, and writing `DRAFT` would assert a state it was
 * never in — see `bookings.service.ts` for why nothing enters `DRAFT`.
 *
 * **`actorId` is null for the platform itself.** An expiry sweep (4.7) and §7.1's
 * auto-decline (4.6) have no human actor, and naming one would be a lie about who
 * decided.
 */
export interface NewBookingEvent {
  readonly bookingId: string;
  readonly type: BookingEventType;
  readonly fromState: BookingState | null;
  readonly toState: BookingState | null;
  readonly actorId: string | null;
  /**
   * Anything a reader needs to understand the change (§6.2's *metadata*).
   *
   * **Nothing personal belongs here.** It is the loosest column in these tables,
   * and §10.1's erasure cannot reach inside a JSON blob. What belongs is what a
   * state change means — a refusal reason, a conflicting booking's id.
   *
   * **Flat scalars only, and the type says so.** Not `unknown`, which would admit
   * a nested object and with it the temptation to put a whole projection in here —
   * the way a metadata column becomes a second copy of the row it describes. It is
   * also what makes the value assignable to a JSON column without a cast.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface BookingEventRecord extends NewBookingEvent {
  readonly id: string;
  readonly createdAt: Date;
}

/**
 * A booking and its history, which is how either party reads one.
 *
 * **Together rather than as two reads**, because §6.2 makes the history part of
 * what a booking *is*, and a projection assembled from two queries can show a
 * state the history does not explain.
 *
 * The line items come from the quote the booking was made from — the store joins
 * it rather than the service fetching it, because a booking without its breakdown
 * cannot be rendered under §3.4.4 and a caller should not be able to forget.
 */
export interface BookingWithEvents {
  readonly booking: BookingRecord;
  readonly lineItems: readonly QuoteLineItem[];
  /** Oldest first, which is how a history reads. */
  readonly events: readonly BookingEventRecord[];
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
   * Write a booking **and its first event, in one transaction** (slice 4.5a).
   *
   * **One method rather than two calls, because a booking with no history is a
   * defect §6.2 forbids** — it calls the event log the booking's *immutable state
   * history*, and a booking whose first state was never recorded has a history
   * that begins with a gap. Two calls from a service would leave that gap open
   * whenever the second one failed.
   *
   * It is also what makes the overlap refusal safe to combine with the write:
   * `OverlappingBookingError` rolls back the event with the booking, so a losing
   * request leaves nothing behind at all.
   *
   * Throws `OverlappingBookingError` exactly as `create` does.
   */
  createWithEvent(
    booking: NewBooking,
    event: Omit<NewBookingEvent, 'bookingId'>,
  ): Promise<BookingRecord>;

  /**
   * One booking belonging to one of its two parties, with its history.
   *
   * **Scoped by *party* rather than by renter**, which is the one read in this
   * module that is not owner-scoped or renter-scoped but both: §8.6 gives the
   * owner the decision and the renter the record, and 4.8's dashboards read the
   * same booking from either side. The scope is in the query — a comparison
   * afterwards is a line somebody can delete.
   *
   * Null covers "no such booking" and "not yours", and the caller must keep them
   * indistinguishable.
   */
  findForParty(id: string, userId: string): Promise<BookingWithEvents | null>;

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
