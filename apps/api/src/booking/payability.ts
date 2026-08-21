/**
 * Whether a renter may pay for a booking, and the sentence they read when they
 * may not (§7, §8.7, slice 5.2d).
 *
 * **Extracted from `bookings.service.ts` so two callers cannot drift.** 5.2c
 * decided all of this inside `pay`, where it refused with a 422. 5.2d needs the
 * same answer *before* anybody presses anything, so the renter's page can render
 * a control that works or a sentence that is true — CLAUDE.md's no-dead-controls
 * rule. Had the projection re-derived it, a page and a route would eventually
 * have told one renter two different stories about one booking.
 *
 * **Pure, and deliberately so.** Every input is passed in: no flag store, no
 * clock, no database. That is what lets the whole matrix — five refusal reasons
 * across the states, both parties, suspended or not, switched on or off — be
 * swept in unit tests without a fixture, the shape 4.1 gave §7's state machine
 * and 5.2a gave the settlement maths.
 */

import type { BookingState } from '@platform/contracts';
import type { BookingPayability } from '@platform/contracts';

/**
 * The states a renter may pay from (§7, slice 5.2c).
 *
 * **Three, and each is a different situation rather than a variation.** `ACCEPTED`
 * is the ordinary one; `PAYMENT_FAILED` is §7's retry edge; `AWAITING_PAYMENT` is
 * a resume, which is what makes a closed tab or a crashed process recoverable.
 *
 * Derived from nothing — listed, like `CALENDAR_OCCUPYING_STATES` — because it is
 * a rule about what a *renter* may do rather than a property of the state graph:
 * §7 also lets `ACCEPTED → RESERVED` directly, and that edge is for a configured
 * collection model nobody has built.
 */
export const PAYABLE_STATES: readonly BookingState[] = Object.freeze([
  'ACCEPTED',
  'AWAITING_PAYMENT',
  'PAYMENT_FAILED',
]);

/**
 * What a renter is told when payment is built but switched off (slice 5.2c).
 *
 * **It says nothing has been charged and the booking is still held**, because
 * those are the two things somebody who just tried to pay actually wants to know.
 * It deliberately does not name a feature flag, an environment or a slice: an
 * operational concept is not a renter's problem, and this sentence is read by the
 * public.
 */
export const PAYMENT_NOT_ENABLED =
  'Paying for bookings is not switched on yet, so nothing has been charged. ' +
  'Your booking is still held.';

/**
 * What the **owner** of the item is told on the booking's own page.
 *
 * **Not a refusal of anything they attempted.** `POST /bookings/:id/pay` answers
 * an owner 404 and must keep doing so (5.2c) — a 403 would confirm the id is real
 * to somebody who is not paying it. This is the other side: an owner may *read*
 * the booking, because `findForParty` answers for both parties, so their page has
 * to say something about the pay control's absence rather than leave a hole where
 * the renter sees a button.
 */
export const ONLY_THE_RENTER_PAYS =
  'The renter pays for this booking. There is nothing for you to pay here.';

/**
 * What a suspended renter is told (ADR 0024).
 *
 * **Paying is transacting, and suspension takes transacting away** — which is why
 * `pay` is not `@AllowsSuspended()` while the read beside it is. Without this the
 * page would render a live button that the guard answers 403 to, which is the
 * dead control this slice exists to remove. They are told what suspension does
 * rather than why they were suspended: the reason is on their account page, in
 * the administrator's own words, and repeating it here would put it on a page
 * about somebody else's item.
 */
export const SUSPENDED_CANNOT_PAY =
  'Your account is suspended, so you cannot pay for a booking at the moment. ' +
  'Your booking is still held. See your account page for what this means.';

/**
 * Why this booking cannot be paid for, as the renter is told.
 *
 * **Switched exhaustively over the states it can actually reach**, so a state
 * added to §7 later cannot silently inherit a sentence written for a different
 * situation — the rule `describeUnavailableToOwner` follows too.
 */
export function describeUnpayable(state: BookingState): string {
  if (state === 'RESERVED') {
    return 'That booking is already paid for. Nothing has been charged again.';
  }
  if (state === 'REQUESTED') {
    return 'That request has not been accepted yet, so there is nothing to pay for.';
  }
  if (state === 'DECLINED' || state === 'EXPIRED' || state === 'CANCELLED') {
    return 'That booking is no longer live, so it cannot be paid for.';
  }
  return 'That booking is past the point of paying for it. Reload the page to see where it stands.';
}

/** Everything that decides whether a pay control should be live. */
export interface PayabilityQuestion {
  readonly state: BookingState;
  /** Whether the person reading is the renter. The owner reads the same booking. */
  readonly isRenter: boolean;
  /** Whether their account is suspended (ADR 0024). */
  readonly isSuspended: boolean;
  /** Whether `booking.payment` is on. */
  readonly paymentEnabled: boolean;
}

/**
 * Whether to draw a pay control, and what to say instead.
 *
 * **The order of the checks is the order a renter would ask them in**, and it is
 * the part worth reading twice. Party first — an owner is not being refused, they
 * are simply not the payer. Then the state, because *"already paid for"* is a
 * better sentence than *"payments are off"* for a booking that is genuinely
 * settled, and a renter told the latter about a `RESERVED` booking would think
 * their money had gone somewhere. Then suspension, then the switch.
 *
 * **The switch is last on purpose.** It is the most temporary of the four — 5.2e
 * removes it — and putting it first would mask all three durable reasons behind
 * one that stops being true, which is how a page comes to say something wrong on
 * the day a flag is flipped rather than on the day it was written.
 */
export function payabilityOf(question: PayabilityQuestion): BookingPayability {
  if (!question.isRenter) {
    return { payable: false, reason: ONLY_THE_RENTER_PAYS };
  }

  if (!PAYABLE_STATES.includes(question.state)) {
    return { payable: false, reason: describeUnpayable(question.state) };
  }

  if (question.isSuspended) {
    return { payable: false, reason: SUSPENDED_CANNOT_PAY };
  }

  if (!question.paymentEnabled) {
    return { payable: false, reason: PAYMENT_NOT_ENABLED };
  }

  return { payable: true };
}
