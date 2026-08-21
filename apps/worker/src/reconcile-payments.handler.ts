import type { Logger } from '@platform/observability';
import { createInternalTrigger } from './internal-trigger.js';
import type { JobEnvelope } from './envelope.js';
import type { ReconcilePaymentsPayload } from './queues.js';

/**
 * The path 5.4a exposed, restated here for the reason
 * `expire-requests.handler.ts` gives: the worker does not depend on
 * `@platform/contracts`, so this is copied and a moved route breaks at runtime
 * rather than at compile time. It breaks loudly — the trigger throws on any non-200.
 */
const RECONCILE_PAYMENTS_PATH = '/internal/payments/reconcile';

/** What the sweep answers with. Read for the log line and nothing else. */
interface ReconciliationResult {
  readonly examined?: number;
  readonly settled?: number;
  readonly stillPending?: number;
  readonly unreconcilable?: number;
  readonly reachedLimit?: boolean;
}

export interface ReconcilePaymentsOptions {
  readonly apiBaseUrl: string;
  readonly secret: string;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Set off 5.4a's reconciliation sweep (slice 5.4b, ADR 0048).
 *
 * **The mechanics are `internal-trigger.ts`'s**; what is here is the narration, and
 * the narration is the whole reason this is a separate file. The two sweeps answer
 * with different shapes and mean different things, and a shared handler that logged
 * both would have to say something vague enough to cover either.
 *
 * ## `unreconcilable` is the line worth reading
 *
 * It counts payment attempts that **cannot be read back at all** — no provider
 * reference, so either the call never left or the answer was lost. In the second
 * case **money may have moved with nothing on our side pointing at it**, and no
 * amount of re-reading will find it.
 *
 * So it is logged at `warn` **separately from the ordinary counts**, on its own
 * line, whatever else the sweep found. Folding it into the summary would put the one
 * number that means *go and look* beside four that mean *everything is fine*.
 *
 * **This is the first thing in the project that deserves an alert rule** alongside
 * `geocode_duration_seconds{outcome="unavailable"}` and `up{service="worker"} == 0`.
 * There are still none; the `warn` is what exists until there are.
 *
 * ## Today it always finds nothing
 *
 * `booking.payment` is off in every environment until 5.2e, so no attempt can be
 * opened and every sweep reports zeroes. That is a job with nothing to do rather than
 * a dead control, and it starts meaning something the moment the flag goes on —
 * with no change to this file.
 */
export function createReconcilePaymentsHandler(
  options: ReconcilePaymentsOptions,
): (envelope: JobEnvelope<ReconcilePaymentsPayload>) => Promise<void> {
  const { logger } = options;

  const trigger = createInternalTrigger({
    ...options,
    path: RECONCILE_PAYMENTS_PATH,
    describedAs: 'reconciliation trigger',
  });

  return async function handle(): Promise<void> {
    const result = (await trigger()) as ReconciliationResult;

    const examined = numberOr(result.examined);
    const unreconcilable = numberOr(result.unreconcilable);

    /*
     * **Its own line, before the summary, and at `warn`.** See the docblock: this is
     * the number that means money may have moved and we cannot find it. It is
     * reported whenever it is non-zero, even on a sweep that was otherwise entirely
     * ordinary.
     *
     * A count, never an id. The API's own line carries the booking id for each; the
     * worker has no reason to hold them and no retention story for them.
     */
    if (unreconcilable > 0) {
      logger.warn('payment attempts could not be reconciled at all', {
        unreconcilable,
      });
    }

    if (examined === 0) {
      // Forty-eight ticks a day, and today every one of them. `debug`, or the log
      // becomes something nobody reads.
      logger.debug('reconciliation sweep found nothing to examine');
      return;
    }

    logger.info('reconciliation sweep examined stale payment attempts', {
      examined,
      settled: numberOr(result.settled),
      stillPending: numberOr(result.stillPending),
    });

    if (result.reachedLimit === true) {
      /*
       * The batch filled, so more may be waiting. **Deliberately not
       * self-enqueued**, for the reason the expiry sweep gives — and with more force
       * here, because every attempt in a batch costs a provider round trip, so a
       * self-queueing loop would be a retry storm against Stripe rather than against
       * our own database.
       */
      logger.warn('reconciliation sweep filled its batch; more may remain', {
        examined,
      });
    }
  };
}

/** A number the API sent, or zero. The worker narrates; it does not validate. */
function numberOr(value: number | undefined): number {
  return typeof value === 'number' ? value : 0;
}
