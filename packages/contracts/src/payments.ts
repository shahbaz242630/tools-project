/**
 * Reconciling payment attempts against the provider (BRD §8.7, §14, slice 5.4a).
 *
 * **The first contract file this module has needed.** Everything Payments has
 * built so far is reached through Booking — a renter pays for *a hire*, so the
 * route is `/bookings/:bookingId/pay` and its shapes live in `bookings.ts`. This
 * is the first thing that is about payments themselves rather than about a
 * booking, and it is addressed to a machine rather than a person.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/**
 * Where the reconciliation sweep is set off (ADR 0048, ADR 0050).
 *
 * **Under `/internal/` because that prefix names its audience.** Every other
 * route in this API answers to somebody holding a session; this answers to a
 * machine holding a shared secret, and the two must be distinguishable at a
 * glance — in a route table, in a log line, and in the edge rule that will
 * eventually refuse the whole prefix from outside.
 *
 * **Not `/payments/reconcile`**, which would sit among routes a person calls.
 */
export const RECONCILE_PAYMENTS_ROUTE = '/internal/payments/reconcile';

/**
 * What one sweep did.
 *
 * **Four counts rather than one, because they mean different things to whoever
 * reads the log.** `settled` is work completed; `stillPending` is the provider
 * saying *not yet*, which is ordinary and expected; `unreconcilable` is the one
 * that should worry somebody — see below. Collapsing them into "examined" and
 * "changed" would hide the only number worth alerting on.
 *
 * **No ids and no amounts.** The caller is a machine with no user, no scope and
 * no business holding either — the rule `expirySweepSchema` set. `strictObject`,
 * so adding a field later is a deliberate act rather than something that leaks in
 * behind a spread.
 */
export const reconciliationSweepSchema = z.strictObject({
  /** Attempts that were stale enough to look at. */
  examined: z.number().int().nonnegative(),

  /** Reached a terminal status — the money either moved or definitively did not. */
  settled: z.number().int().nonnegative(),

  /** The provider says it is still in flight. Ordinary; nothing to do but wait. */
  stillPending: z.number().int().nonnegative(),

  /**
   * Stale attempts carrying **no provider reference**, which cannot be read back.
   *
   * **This is the number that should wake somebody up, and it is reported rather
   * than fixed because it cannot be fixed here.** A row in this state was written
   * before the provider was called and never updated — so either the call never
   * left, or it left and the answer was lost. In the second case money may have
   * moved with nothing on our side pointing at it, and **re-reading cannot find
   * it**: there is no reference to read, and the port deliberately exposes no
   * search-by-idempotency-key.
   *
   * Sweeping them silently would be worse than useless — it would report them as
   * examined and leave the impression they had been checked.
   */
  unreconcilable: z.number().int().nonnegative(),

  /** The batch bound was reached, so the caller should sweep again sooner. */
  reachedLimit: z.boolean(),
});

export type ReconciliationSweep = z.infer<typeof reconciliationSweepSchema>;

export function parseReconciliationSweep(raw: unknown): ReconciliationSweep {
  return parseWith(reconciliationSweepSchema, 'The reconciliation sweep', raw);
}
