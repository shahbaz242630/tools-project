import { Time } from '@platform/core';
import type { Logger } from '@platform/observability';
import { isTerminal } from './payment-intent.js';
import type { PaymentIntentRecord } from './payment-intent.js';
import type { PaymentIntentStore } from './payment-intent-store.js';

/**
 * Catching up with the provider (BRD §8.7, §14's *daily reconciliation job* —
 * slice 5.4a).
 *
 * ## What this exists to survive
 *
 * **An outcome usually arrives out of band, and out-of-band means it can fail to
 * arrive.** A UK card payment often needs a 3-D Secure challenge, so an attempt
 * does not finish when the call returns — the answer comes later, by webhook. A
 * webhook is a network delivery from another company: it can be delayed, dropped,
 * or accepted by an API container that dies before it writes.
 *
 * When that happens the money has moved and **our row still says
 * `processing`** — the booking sits in `AWAITING_PAYMENT`, the ledger has no
 * entry, and nothing in the product will ever fix it on its own. That is the
 * failure this sweep exists for, and it is not exotic: it is the ordinary
 * consequence of relying on a delivery you do not control.
 *
 * **So this is not a webhook replacement, it is the backstop the webhook needs.**
 * 5.2e will verify and process Stripe's deliveries; this catches the ones that
 * never came. Both write through the same `PaymentsService.refresh`, and both are
 * idempotent, so the two racing on one attempt is a no-op rather than a
 * double-post.
 *
 * ## Why it is a separate service
 *
 * The same split `RequestExpiryService` made from `BookingsService`, for the same
 * reason: **every method on `PaymentsService` acts for somebody** — a renter
 * paying, a caller asking about a booking — and a sweep has no actor. It is the
 * platform acting on its own clock, reached by a machine rather than a session.
 * Folding it in would put the one unauthenticated path in the module beside the
 * ones whose whole job is scoping to a caller.
 *
 * ## What it does when payments are switched off, which is today
 *
 * **Nothing, correctly.** `booking.payment` is off in every environment until
 * 5.2e, so no attempt can be opened, so `findUnsettled` returns an empty page and
 * the sweep reports zeroes. That is a job with nothing to do rather than a dead
 * control — the same shape as the expiry sweep on a quiet day — and when the flag
 * goes on it starts working with no change to this file.
 */
/**
 * The one thing the sweep needs from `PaymentsService` (slice 5.4a).
 *
 * **Narrowed rather than taking the service whole**, and not only for testing.
 * `PaymentsService` also opens attempts and takes money; a sweep that held the
 * whole thing could start a payment, and nothing but discipline would stop a later
 * edit doing it. One method is the whole of what reconciling is.
 *
 * `PaymentsService` satisfies this structurally, so `main.ts` passes it directly
 * and a field added there cannot silently change what the sweep can do.
 */
export interface PaymentRefresher {
  refresh(intentId: string): Promise<PaymentIntentRecord | null>;
}

export class ReconciliationService {
  /**
   * How long an attempt may sit unchanged before it is worth chasing.
   *
   * **Long enough that ordinary slowness is not chased.** A 3-D Secure challenge
   * is a person reading a message on their phone and typing a code; fifteen
   * minutes of that is unremarkable. Sweeping at two minutes would spend a
   * provider call on every payment in progress and find nothing, which is both a
   * cost and a rate-limit risk against Stripe.
   *
   * **Short enough that nobody waits a day to find out.** §14 calls the job daily;
   * the *staleness threshold* is not the *schedule*, and conflating them is how a
   * sweep that runs hourly ends up only ever looking at yesterday.
   *
   * Engineering judgement rather than BRD text, and a constant rather than
   * configuration because changing it is a deploy-reviewed decision about how hard
   * we lean on a provider — not something to be turned at 2am.
   */
  static readonly STALE_AFTER_MINUTES = 15;

  /**
   * How many attempts one sweep may examine.
   *
   * Each one is a provider round trip, so this bounds both the wall clock and the
   * calls made. `reachedLimit` tells the caller to come back sooner rather than
   * this quietly truncating — the rule `RequestExpiryService` set.
   */
  static readonly BATCH_LIMIT = 100;

  constructor(
    private readonly intents: PaymentIntentStore,
    private readonly payments: PaymentRefresher,
    private readonly logger: Logger,
    /** Injected so staleness is provable without waiting (ADR 0003). */
    private readonly now: () => Date = Time.nowUtc,
  ) {}

  /**
   * Re-read every stale attempt and apply what the provider says.
   *
   * **One attempt's failure does not abandon the rest.** A provider timeout on the
   * third of ninety is not a reason to leave eighty-seven unreconciled, and the
   * next sweep will pick the failed one up again because nothing about it changed.
   * That is why this catches per attempt rather than letting the sweep throw —
   * deliberately unlike the expiry sweep, whose work is one `UPDATE` that either
   * happens or does not.
   */
  async sweep(): Promise<ReconciliationResult> {
    const staleBefore = Time.addMinutes(
      this.now(),
      -ReconciliationService.STALE_AFTER_MINUTES,
    );

    const stale = await this.intents.findUnsettled(
      staleBefore,
      ReconciliationService.BATCH_LIMIT,
    );

    let settled = 0;
    let stillPending = 0;
    let unreconcilable = 0;
    let failed = 0;

    for (const intent of stale) {
      if (intent.providerReference === undefined) {
        /*
         * **Counted and named, never re-read.** There is no reference to look up.
         * See `reconciliationSweepSchema.unreconcilable` for why this is the
         * number worth alerting on rather than a curiosity: money may have moved
         * with nothing on our side pointing at it, and this sweep cannot find it.
         */
        unreconcilable += 1;
        this.logger.warn('payment attempt cannot be reconciled', {
          paymentIntentId: intent.id,
          status: intent.status,
          /*
           * The booking id, because it is what a human needs to find the hire —
           * and no amount, no payee and no attempt key. An unscoped caller
           * triggered this; the log is read by us, but the rule that a machine
           * path carries no more identity than it must still applies.
           */
          bookingId: intent.bookingId,
        });
        continue;
      }

      try {
        const refreshed = await this.payments.refresh(intent.id);

        if (refreshed !== null && isTerminal(refreshed.status)) settled += 1;
        else stillPending += 1;
      } catch (error) {
        failed += 1;
        this.logger.error('could not reconcile a payment attempt', {
          paymentIntentId: intent.id,
          error,
        });
      }
    }

    return {
      examined: stale.length,
      settled,
      stillPending,
      unreconcilable,
      failed,
      reachedLimit: stale.length >= ReconciliationService.BATCH_LIMIT,
    };
  }
}

/**
 * What a sweep found.
 *
 * **`failed` is on this and deliberately not on the wire.** It counts attempts we
 * could not reach the provider about, which is a fact about *our* run rather than
 * about the payments — the next sweep retries them and the count means nothing to
 * a caller. It is logged and measured here; `reconciliationSweepSchema` omits it.
 */
export interface ReconciliationResult {
  readonly examined: number;
  readonly settled: number;
  readonly stillPending: number;
  readonly unreconcilable: number;
  readonly failed: number;
  readonly reachedLimit: boolean;
}
