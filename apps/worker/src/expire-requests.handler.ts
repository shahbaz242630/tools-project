import type { Logger } from '@platform/observability';
import { createInternalTrigger } from './internal-trigger.js';
import type { JobEnvelope } from './envelope.js';
import type { ExpireRequestsPayload } from './queues.js';

/**
 * The path 4.7a exposed, restated here rather than imported.
 *
 * **`@platform/contracts` is deliberately not a dependency of the worker.** It holds
 * Zod schemas for every API projection, and pulling it in to reach one string
 * constant would give a queue consumer the vocabulary of the whole HTTP surface —
 * and with it the temptation to parse and act on booking projections here, where
 * none of §7's rules live.
 *
 * So it is copied, and the cost is stated: **if the route moves, this breaks at
 * runtime rather than at compile time.** What catches it is
 * `expire-requests.redis.test.ts` plus the walk — and a 404 from a moved route is
 * loud, because the trigger throws on any non-200 and the job fails.
 */
const EXPIRE_REQUESTS_PATH = '/internal/bookings/expire-requests';

/** What the trigger answers with. Read for the log line and nothing else. */
interface SweepResult {
  readonly expired?: number;
  readonly reachedLimit?: boolean;
}

export interface ExpireRequestsOptions {
  /** Where the API is, from `loadWorkerEnv` — validated as a URL at startup. */
  readonly apiBaseUrl: string;
  /** The shared secret, from the shared `loadEnv` (ADR 0048). */
  readonly secret: string;
  readonly logger: Logger;
  /** Injected so a test need not stand up an HTTP server. Defaults to global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Set off 4.7a's expiry sweep (slice 4.7b, ADR 0048).
 *
 * ## Why the work is not here
 *
 * The sweep writes `bookings` and `booking_events` and asserts a §7 transition, all
 * of which belong to the API's Booking module — and this process **cannot reach any
 * of it**: it is ESM to the API's CommonJS (ADR 0011) and has no database client.
 * So this handler holds the *schedule's* half of ADR 0048 and nothing else. It
 * knows one path, one header and one timeout.
 *
 * **It deliberately does not interpret the response beyond logging it.** No state
 * machine, no retry policy of its own, no decision about what an expiry means. If
 * this file ever needs to know what a booking is, something has been put in the
 * wrong process.
 *
 * ## The secret must not reach a log line
 *
 * It is an outbound header here rather than an inbound one, which is the direction
 * that leaks: an error thrown by `fetch` can carry the request in its `cause`, and
 * a logger given the whole error would write the header out. So **the catch block
 * logs a message and never the error object**, and a test asserts the secret
 * appears in nothing this handler writes.
 */
export function createExpireRequestsHandler(
  options: ExpireRequestsOptions,
): (envelope: JobEnvelope<ExpireRequestsPayload>) => Promise<void> {
  const { logger } = options;

  const trigger = createInternalTrigger({
    ...options,
    path: EXPIRE_REQUESTS_PATH,
    describedAs: 'expiry trigger',
  });

  return async function handle(): Promise<void> {
    const result = (await trigger()) as SweepResult;
    const expired = typeof result.expired === 'number' ? result.expired : 0;

    if (expired === 0) {
      // Ninety-six ticks a day, almost all of them empty. `debug`, or the log
      // becomes something nobody reads — the same call the API's sweep makes.
      logger.debug('expiry sweep found nothing');
      return;
    }

    // A count, never an id. The API's own line carries the booking ids; repeating
    // them here would put the same data in two places with two retention stories,
    // and the worker has no reason to know which rows they were.
    logger.info('expiry sweep expired requests', { expired });

    if (result.reachedLimit === true) {
      /*
       * The batch filled, so more may be waiting. **Deliberately not self-enqueued**:
       * at 500 a sweep and four sweeps an hour this drains 2,000 requests an hour
       * against a platform that has six bookings, and a job that queues itself is a
       * recursion worth avoiding until the arithmetic says otherwise. `warn` because
       * it is the one outcome that means *look*.
       */
      logger.warn('expiry sweep filled its batch; more may remain', { expired });
    }
  };
}
