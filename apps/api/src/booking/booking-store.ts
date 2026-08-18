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

/**
 * Thrown when a quote has already become a booking (slice 4.7a).
 *
 * **A named error rather than a leaked `P2002`**, for the reason every adapter here
 * translates one: the caller has to tell "you already asked for this" apart from
 * "the database is down", and without translation a renter's second tab produces a
 * 500 on the most consequential button in the product.
 *
 * **It is deliberately not `OverlappingBookingError`.** Nothing is overlapping and
 * nobody else took the dates — the renter asked twice for the same thing, which
 * needs a different sentence and a different remedy (none, because the first
 * request worked).
 *
 * It carries the quote rather than the winning booking's id: the caller knows which
 * quote it presented, and reading the other row back to name it would be a query on
 * the failure path for a fact the caller does not need.
 */
export class DuplicateQuoteBookingError extends Error {
  constructor(readonly quoteId: string) {
    super(`Quote ${quoteId} has already been used for a booking`);
    this.name = 'DuplicateQuoteBookingError';
  }
}

/**
 * A request waiting on an owner, and what saying yes would cost (slice 4.6).
 *
 * **The conflict count is computed with the request rather than fetched beside
 * it**, because §7.1 makes it part of what the owner must be shown *before*
 * accepting: *"Owners must be shown, before accepting, that competing requests
 * exist and will be declined."* A caller that had to ask a second question could
 * forget to, and the page would silently stop disclosing the consequence.
 */
export interface PendingRequest {
  readonly booking: BookingRecord;
  /** Other `REQUESTED` bookings this one would auto-decline (§7.1). */
  readonly conflictCount: number;
}

/**
 * What an acceptance did (§7.1, slice 4.6).
 *
 * **The auto-declined ids are returned rather than swallowed**, so the caller can
 * emit an event per losing renter — §7.1 requires each of them to be notified with
 * the reason, and Phase 6 is what delivers it. Returning a count instead would
 * make that impossible without a second query for rows we have just written.
 */
export interface AcceptanceResult {
  readonly booking: BookingRecord;
  readonly autoDeclinedIds: readonly string[];
}

/**
 * Thrown when a booking is no longer in the state the caller believed (slice 4.6).
 *
 * **Distinct from "not found", which is what an unowned or missing booking gets.**
 * An owner pressing Accept on a request that expired while the page was open, or
 * that they already declined in another tab, has not asked for something
 * forbidden — they have asked for something that was true a minute ago. The two
 * need different sentences and different status codes.
 */
export class BookingStateChangedError extends Error {
  constructor(
    readonly bookingId: string,
    readonly actual: BookingState,
  ) {
    super(`Booking ${bookingId} is ${actual}, not REQUESTED`);
    this.name = 'BookingStateChangedError';
  }
}

/**
 * One request that a sweep moved to `EXPIRED` (§8.6, slice 4.7a).
 *
 * **The renter is carried and the owner is not.** §7.1's auto-decline already
 * establishes who has to be told when a request dies without an answer: the person
 * who asked. An owner who let a deadline pass has not been waiting for anything.
 * Phase 6 is what delivers it.
 *
 * **Three ids and nothing else.** No dates, no money, no item name — a sweep is
 * not a projection, and everything a later notification needs is already on the
 * booking, reachable by id through `findForParty`. Widening this is how a
 * background job comes to hold a copy of the row it just changed.
 */
export interface ExpiredRequest {
  readonly id: string;
  readonly renterId: string;
  readonly listingId: string;
}

/**
 * What one expiry sweep did (§14's *request expiry worker*, slice 4.7a).
 *
 * **`reachedLimit` rather than a total count of what is outstanding.** Counting
 * everything overdue means a second query on every sweep, forever, to answer a
 * question that only matters in the rare case where the batch filled up. The flag
 * costs nothing and says the one thing a caller can act on: *ask again sooner*.
 */
export interface ExpirySweepResult {
  readonly expired: readonly ExpiredRequest[];
  /** The batch bound was hit, so more overdue requests may remain. */
  readonly reachedLimit: boolean;
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

  /**
   * The unanswered requests against one of this owner's listings (§8.6, slice 4.6).
   *
   * **Owner-scoped in the query, never by a comparison afterwards** — the rule
   * `findForParty` states at length. An owner who does not own this listing gets
   * an empty list, indistinguishable from a listing nobody has asked for.
   *
   * **Expired requests are excluded here rather than swept first.** 4.7's worker
   * will move them to `EXPIRED`; until it exists, a request past its deadline must
   * not be offered to an owner as something they may still accept — §8.6 gives it a
   * deadline and a page that ignored it would be the deadline not existing.
   */
  findPendingRequests(
    listingId: string,
    ownerId: string,
    now: Date,
  ): Promise<readonly PendingRequest[]>;

  /**
   * Accept one request, lock the dates, and decline every conflict — **in one
   * transaction** (§7.1).
   *
   * §7.1 is unusually prescriptive and this is a transcription of it: *"On
   * acceptance, in a single database transaction, the system must: acquire the
   * exclusive availability lock; move the accepted booking to `ACCEPTED`; and move
   * every other `REQUESTED` booking whose dates overlap the accepted period to
   * `DECLINED` with reason `AUTO_DECLINED_CONFLICT`."*
   *
   * **The lock is acquired by the write itself, not by a query before it.**
   * Moving the booking into `ACCEPTED` puts it in one of §8.5.1's nine
   * calendar-occupying states, which is exactly when the `EXCLUDE` constraint
   * begins to apply to it — so the database refuses a second acceptance rather
   * than the application noticing one. §8.5.1 names check-then-insert as the
   * anti-pattern by name.
   *
   * Returns null when the booking does not exist or is not this owner's. Throws
   * `BookingStateChangedError` when it is no longer `REQUESTED`, and
   * `OverlappingBookingError` when another booking already holds the dates.
   */
  accept(
    bookingId: string,
    ownerId: string,
    now: Date,
  ): Promise<AcceptanceResult | null>;

  /**
   * Decline one request (§8.6).
   *
   * **No transaction beyond the row and its event**, unlike acceptance: a decline
   * frees nothing and locks nothing, so there is no conflict set to resolve and no
   * constraint to race against. The asymmetry is worth noticing rather than
   * smoothing over — it is why saying no is cheap and saying yes is not.
   */
  decline(bookingId: string, ownerId: string, now: Date): Promise<BookingRecord | null>;

  /**
   * Move every `REQUESTED` booking past its §8.6 deadline to `EXPIRED`, and write
   * an event for each (slice 4.7a).
   *
   * **No actor and no owner scope**, unlike every other write here. This is the
   * platform acting on its own deadline, so the events it writes carry
   * `actorId: null` — the schema's own words: *"recording one would be a lie about
   * who decided."*
   *
   * **Idempotent by construction, not by a claim.** The state predicate lives in
   * the `UPDATE` itself, so a booking accepted or declined a millisecond earlier is
   * simply not matched: two sweeps racing, or one retried after a timeout, cannot
   * expire the same booking twice or expire something that stopped being
   * `REQUESTED`. That is what lets this run unattended and be re-run freely.
   *
   * **Bounded, and the bound is the caller's.** A sweep is the one operation here
   * that can meet an arbitrarily large backlog — a worker down for a week returns to
   * everything that lapsed meanwhile — and an unbounded `UPDATE` on that would hold
   * locks for as long as it takes while the API waits behind it. The result says
   * whether the bound was hit.
   *
   * **`requestExpiresAt` is read and no configuration is.** 4.5a stamped the
   * deadline onto the row from the category version in force at the time, which is
   * §8.2's copied-terms rule — so a request is judged against the deadline it was
   * made under, and re-configuring the category cannot retroactively expire or
   * revive anything.
   *
   * Returns the requests it expired, oldest deadline first.
   */
  expireRequests(now: Date, limit: number): Promise<ExpirySweepResult>;
}
