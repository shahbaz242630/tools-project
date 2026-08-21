import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { RECONCILE_PAYMENTS_ROUTE } from '@platform/contracts';
import type { ReconciliationSweep } from '@platform/contracts';
import { InternalTriggerGuard } from '../internal-trigger/internal-trigger.guard.js';
import { RECONCILIATION_SERVICE } from './payments.tokens.js';
import type { ReconciliationService } from './reconciliation.service.js';

/**
 * Where the reconciliation sweep is set off (slice 5.4a, ADR 0048).
 *
 * **The second `InternalTriggerGuard` route in the API**, and the guard moved out
 * of `booking/` to make it so: it was born there with the expiry sweep, but it
 * describes a *machine caller*, not a booking, and Payments has no domain reason
 * to depend on Booking. It now sits beside `rate-limiting/` as platform
 * infrastructure — the same call `describeLine` got when it acquired a second
 * caller.
 *
 * Everything `RequestExpiryController` says about this shape holds here and is not
 * repeated: `POST` so nothing crawls it, no idempotency key because the work is
 * already idempotent, and none of the session decorators, because none of those
 * concepts exist on this path.
 *
 * **This one adds a reason to read the response body rather than only its status.**
 * The expiry sweep's counts are informational; `unreconcilable` here is the number
 * that means *money may have moved and we cannot find it*. It is a `warn` in the
 * service and a field on the wire so that a worker log and an eventual alert rule
 * can both see it.
 */
@Controller()
@UseGuards(InternalTriggerGuard)
export class ReconciliationController {
  constructor(
    @Inject(RECONCILIATION_SERVICE)
    private readonly reconciliation: ReconciliationService,
  ) {}

  /**
   * Re-read every stale payment attempt.
   *
   * **200 with counts, even when nothing was stale** — the overwhelmingly common
   * case, and today the only one, because no attempt can be opened while
   * `booking.payment` is off. A sweep that found nothing has succeeded.
   *
   * **`failed` is deliberately not projected.** It is a fact about this run rather
   * than about the payments, the next sweep retries them, and
   * `reconciliationSweepSchema` is a `strictObject` — so it cannot leak in behind
   * a spread either.
   */
  @Post(RECONCILE_PAYMENTS_ROUTE)
  @HttpCode(200)
  async reconcile(): Promise<ReconciliationSweep> {
    const swept = await this.reconciliation.sweep();

    return {
      examined: swept.examined,
      settled: swept.settled,
      stillPending: swept.stillPending,
      unreconcilable: swept.unreconcilable,
      reachedLimit: swept.reachedLimit,
    };
  }
}
