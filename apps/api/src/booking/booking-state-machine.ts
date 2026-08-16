import { BOOKING_STATES } from '@platform/contracts';
import type { BookingState } from '@platform/contracts';

/**
 * §7's state machine — **the one place a booking transition is decided**
 * (slice 4.1).
 *
 * §7 opens: *"Booking states must be explicit and validated centrally. UI
 * buttons must never directly invent transitions."* This is that centre. It is
 * built before there is a `bookings` table on purpose, so that no later slice
 * ever has a moment where putting a state change in a handler is the path of
 * least resistance — by the time there is a row to write, the rule already
 * exists and refusing to use it is a visible choice.
 *
 * **It is pure.** No database, no clock, no identity. What it cannot know it
 * does not take: whether *this person* may make *this* move is authorisation,
 * whether the dates are free is the exclusion constraint (slice 4.2), and
 * whether the money moved is Phase 5. This answers one question — is the move
 * legal at all — and answering it needs nothing but the two states.
 *
 * **The table is data rather than a `switch`.** §7 says a transition target
 * with no row in its table is a specification defect, which is only checkable
 * if our table is also a table: `TRANSITIONS` can be read against the BRD line
 * by line, and the tests below assert properties *of the structure* — every
 * target exists, every state is reachable, terminals go nowhere — which no
 * amount of branching would let them do.
 */

/**
 * §7's table, verbatim: for each state, the states it may move to.
 *
 * **Transcribed in the BRD's own order and with the BRD's own targets**, so a
 * reader can diff the two by eye. Where §7's *"Allowed next states"* column says
 * `None (terminal)` the entry is an empty array rather than an absent key — an
 * absent key and an unknown state are different failures, and only one of them
 * is a bug.
 *
 * **Nothing here is inferred.** It would be tempting to derive, say, "anything
 * may be cancelled", and it would be wrong: §7 permits `CANCELLED` from six
 * states and not from `COLLECTED`, because once an item has changed hands the
 * answer is a return or a dispute rather than a cancellation. Every edge that
 * exists is one the specification wrote down.
 */
export const TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> =
  Object.freeze({
    DRAFT: ['REQUESTED', 'ABANDONED'],
    ABANDONED: [],
    REQUESTED: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
    ACCEPTED: ['AWAITING_PAYMENT', 'RESERVED'],
    AWAITING_PAYMENT: ['RESERVED', 'PAYMENT_FAILED', 'EXPIRED'],
    PAYMENT_FAILED: ['AWAITING_PAYMENT', 'EXPIRED', 'CANCELLED'],
    RESERVED: ['READY_FOR_COLLECTION', 'CANCELLED', 'DISPUTED'],
    READY_FOR_COLLECTION: ['COLLECTED', 'NO_SHOW', 'CANCELLED', 'SECURITY_FAILED'],
    SECURITY_FAILED: ['READY_FOR_COLLECTION', 'CANCELLED', 'DISPUTED'],
    NO_SHOW: ['CANCELLED', 'DISPUTED', 'CLOSED'],
    COLLECTED: ['RETURN_DUE', 'RETURNED_PENDING_CONFIRMATION', 'DISPUTED'],
    RETURN_DUE: ['RETURNED_PENDING_CONFIRMATION', 'LATE'],
    LATE: ['RETURNED_PENDING_CONFIRMATION', 'DISPUTED'],
    RETURNED_PENDING_CONFIRMATION: ['COMPLETED', 'DISPUTED'],
    COMPLETED: ['REVIEW_WINDOW'],
    REVIEW_WINDOW: ['CLOSED'],
    DISPUTED: ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CLOSED'],
    REFUNDED: ['CLOSED'],
    PARTIALLY_REFUNDED: ['CLOSED'],
    DECLINED: ['CLOSED'],
    EXPIRED: ['CLOSED'],
    CANCELLED: ['CLOSED'],
    CLOSED: [],
  });

/**
 * The states that occupy a listing's calendar — **§8.5.1's nine, and the set
 * slice 4.2's `EXCLUDE` constraint is scoped to**.
 *
 * **Written out rather than derived, and that is the decision.** The tempting
 * shortcut is a predicate — "everything from `ACCEPTED` to `LATE`" — and it is
 * wrong twice over: the states are not contiguous in any ordering, and a rule
 * inferred from position would silently change meaning the moment a state is
 * added. §8.5.1 names exactly these nine and calls the mechanism normative, so
 * this is a transcription and the test beside it is a transcription check.
 *
 * **`REQUESTED` is deliberately absent and that is the whole design of §7.1.**
 * Several renters may hold a request against the same listing and the same
 * dates; none of them reserves anything, and the first *acceptance* to commit
 * wins. A `REQUESTED` booking that blocked the calendar would make the first
 * person to click, rather than the owner, decide who gets the item — and would
 * let anybody freeze a listing for free.
 *
 * **`DISPUTED` is absent too, and this one is worth pausing on.** A dispute can
 * be opened from `RESERVED` or `COLLECTED`, and while it runs the dates are no
 * longer being protected by this constraint. That is correct for the common case
 * — a dispute usually outlives the rental period and holding the calendar would
 * strand a listing indefinitely — but it means Phase 8 must decide explicitly
 * what a dispute does to availability rather than inheriting an answer from
 * here. Recorded now, because the absence looks like an oversight later.
 */
export const CALENDAR_OCCUPYING_STATES: readonly BookingState[] = Object.freeze([
  'ACCEPTED',
  'AWAITING_PAYMENT',
  'PAYMENT_FAILED',
  'RESERVED',
  'READY_FOR_COLLECTION',
  'SECURITY_FAILED',
  'COLLECTED',
  'RETURN_DUE',
  'LATE',
]);

/** Whether a booking in this state is holding dates against a listing. */
export function occupiesCalendar(state: BookingState): boolean {
  return CALENDAR_OCCUPYING_STATES.includes(state);
}

/**
 * States nothing may leave — §7's two `None (terminal)` rows.
 *
 * **Derived from the table rather than listed**, which is the opposite choice
 * from `CALENDAR_OCCUPYING_STATES` above and for a reason worth stating: being
 * terminal *is* having no outgoing edges, so a second list could only ever
 * disagree with the first. §8.5.1's nine, by contrast, are a rule about
 * something else — what blocks a calendar — that happens to be expressed over
 * the same values, so it has to be stated independently and checked.
 */
export const TERMINAL_STATES: readonly BookingState[] = Object.freeze(
  BOOKING_STATES.filter((state) => TRANSITIONS[state].length === 0),
);

export function isTerminal(state: BookingState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Whether §7 permits this move. */
export function canTransition(from: BookingState, to: BookingState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Thrown when something tries to make a move §7 does not permit.
 *
 * **An error rather than a boolean return, at this layer**, because a refused
 * transition is a bug in the caller rather than a condition a caller handles:
 * every legitimate path already knows which state it is moving to. `canTransition`
 * is there for the callers that genuinely ask a question — the dashboards
 * deciding which buttons exist — and `assertTransition` is for the ones taking
 * an action.
 *
 * **It names both states.** A message reading *"invalid transition"* is one
 * somebody has to reproduce to understand; this one is diagnosable from a log
 * line, which matters most for the transitions nothing on screen triggers —
 * the expiry worker in 4.7 and §7.1's auto-decline.
 */
export class InvalidBookingTransitionError extends Error {
  constructor(
    readonly from: BookingState,
    readonly to: BookingState,
  ) {
    super(`A booking cannot move from ${from} to ${to}`);
    this.name = 'InvalidBookingTransitionError';
  }
}

/**
 * Take the move, or refuse it.
 *
 * **Returns the new state rather than mutating anything**, because there is no
 * booking here to mutate — and keeping it that way is what lets slice 4.2 call
 * this *inside* the transaction that writes the row, with the constraint and the
 * state rule enforced together or not at all.
 */
export function assertTransition(from: BookingState, to: BookingState): BookingState {
  if (!canTransition(from, to)) {
    throw new InvalidBookingTransitionError(from, to);
  }
  return to;
}
