import type { MoneyValue } from '@platform/core';
import type { PaymentAttemptStatus, PaymentFailure } from './payment-provider.js';

/**
 * What the platform records about an attempt to move money (BRD §6.2, §8.7,
 * slice 5.2b).
 *
 * §6.2's *Payment intent* is *"an external payment operation"* carrying a
 * provider reference, a status, an idempotency key and an authorisation expiry.
 * This file is that entity's vocabulary and the one rule about it that cannot
 * live in the database: **which status may follow which**.
 *
 * **It is the mutable half of Phase 5, and the ledger is the immutable half.**
 * That is not an inconsistency — the ledger records what *happened* and §8.7
 * makes it permanent, while an intent records what is *happening* at somebody
 * else's system, which genuinely changes. Under Strong Customer Authentication a
 * card payment begins as a challenge in a browser and becomes an outcome minutes
 * later, by webhook. A record of that written into an append-only table would be
 * a state machine spelled as history, with no way to ask what is true now.
 *
 * **Pure, with no store and no Nest**, the shape 4.1 and 5.1 both took: the rule
 * that decides whether an outcome may be applied is the part that must be right
 * before anything writes one.
 */

/**
 * What an attempt is for.
 *
 * **One value today, and the second is not written in advance.** §8.7.2's
 * damage-security hold is the obvious next one — it is the reason
 * `authorisationExpiresAt` exists at all — but the rule slice 5.1 set for ledger
 * account kinds holds here too: a value arrives **with the flow that writes it**,
 * and with a test. A vocabulary invented ahead of its flow is one nobody can
 * exercise.
 */
export const PAYMENT_INTENT_PURPOSES = ['hire_charge'] as const;
export type PaymentIntentPurpose = (typeof PAYMENT_INTENT_PURPOSES)[number];

/**
 * Where an attempt has got to, as *we* record it.
 *
 * **The provider port's four statuses plus `initiated`**, and that extra one is
 * the whole reason this is a separate union rather than a re-export of
 * `PaymentAttemptStatus`. The row is written **before** the provider is called,
 * so that a crash between the write and the call leaves a record of an attempt
 * we may have made rather than an untraceable charge. `initiated` is the state
 * that record is in, and no provider will ever report it because it describes
 * something on our side of the wire.
 *
 * **It can grow, which is why the database has no `CHECK` on it** — unlike
 * `ledger_entries.direction`, whose two values will never gain a third. §8.7
 * already names *"failed payments, expired authorisations, chargebacks and
 * negative balances"*, so `expired` and `charged_back` are values a later slice
 * adds. Text with the vocabulary in code is the same call `bookings.state`
 * makes, and for the same reason.
 */
export const PAYMENT_INTENT_STATUSES = [
  'initiated',
  'pending_payer_action',
  'processing',
  'succeeded',
  'failed',
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * The statuses an attempt never leaves.
 *
 * **`failed` is terminal, and that is a decision rather than an accident.** A
 * renter whose card was declined is entitled to try again — but that retry is a
 * *new attempt* with a new key, not this one changing its mind. It has to be,
 * because the provider idempotency key is per attempt: re-presenting the first
 * key would return the first failure forever. One intent is one attempt, and the
 * per-attempt key on the row is what makes that true.
 */
const TERMINAL_STATUSES: readonly PaymentIntentStatus[] = ['succeeded', 'failed'];

/** Whether an attempt in this status can still change. */
export function isTerminal(status: PaymentIntentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Raised when an attempt cannot be made or an outcome cannot be applied. */
export class PaymentIntentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PaymentIntentError';
  }
}

/**
 * What a hire charge divides into, copied onto the attempt when it opens.
 *
 * **Carried on the row rather than fetched when needed, and the reason is the
 * webhook.** An attempt's outcome usually arrives out of band: a 3-D Secure
 * challenge finishes minutes after the request that started it, and the
 * confirmation carries a provider reference and nothing else. Whatever handles
 * that has no booking in hand — and Payments may not read `bookings` (BRD §5.1)
 * — so an attempt that cannot say how to divide itself is one the ordinary
 * journey can never complete. This is §8.2's copy-the-terms pattern one step
 * further along than the booking that already applies it.
 */
export interface HireSettlementTerms {
  /** Who is owed the proceeds — the listing's owner. */
  readonly ownerId: string;
  /** The version whose fee policy divides this, pinned by the booking (§8.2). */
  readonly categoryVersionId: string;
  readonly itemCharge: MoneyValue;
  readonly renterFee: MoneyValue;
}

/** An attempt, as a caller opens one. */
export interface NewPaymentIntent extends HireSettlementTerms {
  readonly bookingId: string;
  readonly purpose: PaymentIntentPurpose;
  /**
   * What makes a double-pressed pay button one charge.
   *
   * Unique in the database, so the second press finds the row rather than
   * opening a second attempt — and no second provider call is made.
   */
  readonly attemptKey: string;
  /**
   * What the payer is charged — the item charge plus the renter fee.
   *
   * A `CHECK` requires it to be exactly that sum, so a row that disagrees with
   * itself is unrepresentable rather than merely wrong.
   */
  readonly amount: MoneyValue;
  /** `PaymentProvider.name`, stored so the row stays readable after a move. */
  readonly provider: string;
}

/** What a provider told us, in the shape the store writes. */
export interface PaymentIntentOutcome {
  readonly status: PaymentAttemptStatus;
  /**
   * The provider's identifier for the attempt.
   *
   * **A reference beside our own id, never a key** (ADR 0051). Required by a
   * `CHECK` once the status is `succeeded`, because that is when the daily
   * reconciliation §8.7 requires has to match something.
   */
  readonly providerReference: string;
  /**
   * The provider's **real** expiry timestamp for a hold (§8.7.2, normative —
   * `capture_before`), never a duration we assumed.
   *
   * Absent for a hire charge, which is captured outright and holds nothing.
   */
  readonly authorisationExpiresAt?: Date;
  /** Present only when the status is `failed`. */
  readonly failure?: PaymentFailure;
}

/** An attempt as it reads back. */
export interface PaymentIntentRecord extends HireSettlementTerms {
  readonly id: string;
  readonly bookingId: string;
  readonly purpose: PaymentIntentPurpose;
  readonly attemptKey: string;
  readonly status: PaymentIntentStatus;
  readonly provider: string;
  readonly providerReference?: string;
  readonly amount: MoneyValue;
  readonly authorisationExpiresAt?: Date;
  readonly failure?: PaymentFailure;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What applying an outcome to an attempt should do.
 *
 * Two answers rather than a boolean, because the second one is the case
 * §11.2's gate is actually about: *"duplicate and out-of-order provider webhooks
 * produce exactly one ledger effect"*. A webhook delivered twice is **not** an
 * error and must not be treated as one — it is the normal behaviour of every
 * provider's retry policy — and it must not post a second time either.
 */
export type OutcomeDisposition =
  /** New information. Write it, and post to the ledger if it succeeded. */
  | { readonly kind: 'apply' }
  /** Already known. Change nothing and post nothing. */
  | { readonly kind: 'ignore'; readonly why: string };

/**
 * Decide what an arriving outcome means for an attempt in this status.
 *
 * **Out-of-order delivery is the case worth reading twice.** Providers do not
 * guarantee webhook order, so `processing` can legitimately arrive *after*
 * `succeeded` for the same attempt. Applying it would move a finished payment
 * back to unfinished, and the next reconciling read would move it forward
 * again — a row that oscillates and a support conversation nobody can win.
 * A terminal status is therefore the last word: a contradicting outcome is
 * refused loudly, and a repeat of the same one is ignored quietly.
 *
 * Throws {@link PaymentIntentError} when the outcome contradicts something
 * already settled. That is deliberately noisy: it means either the provider has
 * reported two different endings for one attempt, or we have presented one
 * attempt's key for another's money. Both are worth waking somebody for, and
 * neither is recoverable by guessing.
 */
export function dispositionOf(
  current: PaymentIntentStatus,
  arriving: PaymentAttemptStatus,
): OutcomeDisposition {
  if (current === arriving) {
    return { kind: 'ignore', why: `already ${current}` };
  }

  if (isTerminal(current)) {
    throw new PaymentIntentError(
      `a payment attempt that has ${current} cannot become ${arriving}: ` +
        'a settled attempt is the last word, and a retry is a new attempt',
    );
  }

  return { kind: 'apply' };
}

/**
 * Refuse an attempt key that has been reused for different money.
 *
 * **The same argument `LedgerService.post` makes about idempotency keys, and it
 * lives here for the same reason that one lives in the service**: silently
 * returning the earlier attempt would be idempotent in the letter and wrong in
 * substance — the caller believes it opened an attempt for the amount it passed,
 * and it did not. A key reused by accident, a booking id where an attempt id was
 * meant, is a defect, and the only moment it is cheap to find is now.
 *
 * **Not in the adapter**, so it is one rule rather than two: an adapter and a
 * fake each enforcing it is two places for it to drift, and the fake is the one
 * every service test would be believing.
 */
export function assertSameAttempt(
  proposed: NewPaymentIntent,
  found: PaymentIntentRecord,
): PaymentIntentRecord {
  const differs =
    found.bookingId !== proposed.bookingId ||
    found.purpose !== proposed.purpose ||
    found.ownerId !== proposed.ownerId ||
    found.categoryVersionId !== proposed.categoryVersionId ||
    found.itemCharge.amount !== proposed.itemCharge.amount ||
    found.renterFee.amount !== proposed.renterFee.amount ||
    found.amount.amount !== proposed.amount.amount ||
    found.amount.currency !== proposed.amount.currency;

  if (differs) {
    throw new PaymentIntentError(
      `attempt key ${proposed.attemptKey} has already been used for a different payment`,
    );
  }

  return found;
}

/**
 * The provider idempotency key for one attempt at a hire's charge (slice 5.2c).
 *
 * **Derived from how many attempts have already failed, not from a counter and
 * not from the caller.** That is what makes it race-safe without a lock, and the
 * three cases it has to get right are worth spelling out:
 *
 * - **Two presses of pay, milliseconds apart.** Both see the same failure count,
 *   both mint the same key, and the unique index turns the second into a read of
 *   the first. One charge.
 * - **A press while a 3-D Secure challenge is still in flight.** Nothing has
 *   failed, so the count is unchanged and the key is the same one — the attempt is
 *   found, `payForHire` short-circuits, and the payer is not charged twice for a
 *   payment they are halfway through.
 * - **A press after a decline.** The count moved, so the key is new — which it
 *   must be, because the provider's own idempotency would otherwise hand back the
 *   first failure forever.
 *
 * **A succeeded attempt needs no case**, because the booking leaves the payable
 * states the moment one lands.
 *
 * **The caller does not supply this**, and a browser least of all: a key minted
 * client-side is a key a client can reuse, vary or lose, and every one of those
 * is a double charge or an unpayable booking.
 */
export function hireAttemptKey(bookingId: string, failedAttempts: number): string {
  return `hire:${bookingId}:${String(failedAttempts)}`;
}

/**
 * The ledger idempotency key for a hire's capture.
 *
 * **Per booking, deliberately — where the provider's key is per attempt.** A
 * hire is captured once however many times somebody tried, so the key that makes
 * the posting exactly-once has to be the one thing that does not change between
 * attempts. §11.2 requires duplicate webhooks to produce one ledger effect, and
 * this is what delivers it; `LedgerService.post` returns the first posting when
 * the key repeats with identical content, and **throws when the content
 * differs** — which is precisely the alarm we would want if a booking were
 * somehow captured twice for different amounts.
 */
export function hireCaptureKey(bookingId: string): string {
  return `hire-capture:${bookingId}`;
}
