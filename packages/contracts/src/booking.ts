import { z } from 'zod';

/**
 * What a booking can be, as everything names it (BRD §7, slice 4.1).
 *
 * **This file holds the vocabulary and deliberately not the rules.** §7 opens
 * with *"Booking states must be explicit and validated centrally. UI buttons
 * must never directly invent transitions."* The transition table lives in
 * `apps/api/src/booking/`, where the web app cannot reach it — because a table
 * exported from here is a table a page can read, and a page that can compute
 * *"`ACCEPTED` may become `RESERVED`"* is one button away from deciding a
 * transition on the client.
 *
 * **What a page gets instead is what it may *do***: the API answers with the
 * actions available to *this* person on *this* booking. That is a different and
 * smaller question than which transitions exist, and it is the only one a page
 * can answer correctly anyway — an owner and a renter looking at the same
 * `REQUESTED` booking see different buttons, and no transition table encodes
 * that.
 *
 * So the split is: **a state is a noun both sides say, a transition is a verb
 * only the server conjugates.**
 */

/**
 * Every state in §7's table, in the order that table lists them.
 *
 * **The order is the specification's, not alphabetical and not a lifecycle.**
 * It is kept so that a reader comparing this array against §7 can do it line by
 * line — which is the check that catches a state quietly going missing, and the
 * BRD is normative here in a way it rarely is about ordering.
 *
 * **Twenty-two states is a lot, and none of them is optional.** §7 says a
 * transition target with no row in its table is a specification defect; the
 * inverse is also true, and a state defined but never reachable would be one.
 * `booking-state-machine.ts` asserts both.
 */
export const BOOKING_STATES = [
  'DRAFT',
  'ABANDONED',
  'REQUESTED',
  'ACCEPTED',
  'AWAITING_PAYMENT',
  'PAYMENT_FAILED',
  'RESERVED',
  'READY_FOR_COLLECTION',
  'SECURITY_FAILED',
  'NO_SHOW',
  'COLLECTED',
  'RETURN_DUE',
  'LATE',
  'RETURNED_PENDING_CONFIRMATION',
  'COMPLETED',
  'REVIEW_WINDOW',
  'DISPUTED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'CLOSED',
] as const;

export type BookingState = (typeof BOOKING_STATES)[number];

export const bookingStateSchema = z.enum(BOOKING_STATES);

/**
 * Where every booking starts.
 *
 * `DRAFT` rather than `REQUESTED`, because §7 gives the renter a state before
 * they have committed to anything — and `ABANDONED` exists to absorb the ones
 * that never go further, which is most of them on any marketplace.
 */
export const INITIAL_BOOKING_STATE: BookingState = 'DRAFT';

/**
 * Why a booking left the road — recorded beside the state, never instead of it.
 *
 * **A separate vocabulary rather than more states**, and §7.1 is what forces
 * it: an owner declining and the platform auto-declining a loser of the race
 * both produce `DECLINED`, and the *renter is told which*. Encoding that as two
 * states would mean two rows in §7's table that the BRD does not have, and
 * every consumer of `DECLINED` would have to remember both.
 *
 * - **`OWNER_DECLINED`** — a person read the request and said no.
 * - **`AUTO_DECLINED_CONFLICT`** — §7.1's exact term. Somebody else's request
 *   for overlapping dates was accepted first. **This is not a rejection of the
 *   renter**, and the message they get must not read like one: §7.1 requires
 *   them to be told the reason and prompted to search alternatives.
 *
 * **Deliberately not a free-text field.** A reason a person types is a reason
 * that reaches another member unreviewed, and it is the sort of thing that ends
 * up in a screenshot. Where §8 later wants an owner's own words, that is a
 * message in Phase 6's conversation, not a column on a state transition.
 */
export const BOOKING_DECLINE_REASONS = [
  'OWNER_DECLINED',
  'AUTO_DECLINED_CONFLICT',
] as const;

export type BookingDeclineReason = (typeof BOOKING_DECLINE_REASONS)[number];

export const bookingDeclineReasonSchema = z.enum(BOOKING_DECLINE_REASONS);

/**
 * What a state is called on screen.
 *
 * **Here rather than in the web app, because two surfaces will render it** —
 * the renter's dashboard and the owner's, both in slice 4.8 — and a state
 * spelled two ways is two different things to somebody reading both.
 *
 * **Sentence case, and never the raw constant.** `RETURNED_PENDING_CONFIRMATION`
 * is a database value; *"Returned, waiting for the owner to confirm"* is what a
 * person is owed, and the difference is the same one slice 3.1d found when zod's
 * internal message reached a page.
 *
 * **These are not status *explanations*.** A label says what the state is; what
 * it means for you and what you do next depend on which side of the booking you
 * are on, and that belongs to the dashboards that know.
 */
export const BOOKING_STATE_LABELS: Readonly<Record<BookingState, string>> =
  Object.freeze({
    DRAFT: 'Draft',
    ABANDONED: 'Abandoned',
    REQUESTED: 'Requested',
    ACCEPTED: 'Accepted',
    AWAITING_PAYMENT: 'Awaiting payment',
    PAYMENT_FAILED: 'Payment failed',
    RESERVED: 'Reserved',
    READY_FOR_COLLECTION: 'Ready for collection',
    SECURITY_FAILED: 'Deposit hold failed',
    NO_SHOW: 'Nobody turned up',
    COLLECTED: 'Collected',
    RETURN_DUE: 'Return due',
    LATE: 'Overdue',
    RETURNED_PENDING_CONFIRMATION: 'Returned, awaiting confirmation',
    COMPLETED: 'Completed',
    REVIEW_WINDOW: 'Open for reviews',
    DISPUTED: 'In dispute',
    REFUNDED: 'Refunded',
    PARTIALLY_REFUNDED: 'Partly refunded',
    DECLINED: 'Declined',
    EXPIRED: 'Expired',
    CANCELLED: 'Cancelled',
    CLOSED: 'Closed',
  });
