import type { Logger } from '@platform/observability';
import type { JobEnvelope } from './envelope.js';
import type { ExpireRequestsPayload } from './queues.js';

/**
 * The path and header 4.7a exposed, restated here rather than imported.
 *
 * **`@platform/contracts` is deliberately not a dependency of the worker.** It
 * holds Zod schemas for every API projection, and pulling it in to reach two string
 * constants would give a queue consumer the vocabulary of the whole HTTP surface —
 * and with it the temptation to parse and act on booking projections here, where
 * none of §7's rules live. The worker's job is to *call* the trigger, not to
 * understand what came back.
 *
 * So these two are copied, and the cost is stated: **if the route moves, this
 * breaks at runtime rather than at compile time.** What catches it is
 * `expire-requests.redis.test.ts` plus the walk — and a 404 from a route that moved
 * is loud, because the handler throws on any non-200 and the job fails.
 */
const EXPIRE_REQUESTS_PATH = '/internal/bookings/expire-requests';
const INTERNAL_TRIGGER_HEADER = 'x-internal-trigger';

/**
 * How long to wait for the sweep before giving up.
 *
 * **Shorter than the fifteen-minute schedule by a wide margin**, so a hung request
 * cannot still be in flight when the next tick fires — two concurrent sweeps are
 * harmless (the work is idempotent) but a pile of them waiting on a dead socket is
 * a worker slowly filling with jobs that will never finish.
 *
 * Thirty seconds is generous for one bounded `UPDATE` against a database in the
 * same region, and the point is to bound it at all: `fetch` with no signal waits on
 * the OS, which for a black-holed connection is minutes.
 */
const TRIGGER_TIMEOUT_MS = 30_000;

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
  const { apiBaseUrl, secret, logger, fetchImpl = fetch } = options;

  // Resolved once. `new URL(path, base)` rather than string concatenation, so a
  // trailing slash on the base cannot produce `//internal/...`.
  const target = new URL(EXPIRE_REQUESTS_PATH, apiBaseUrl).toString();

  return async function handle(): Promise<void> {
    /*
     * `AbortSignal.timeout` rather than a manual controller and timer: it needs no
     * cleanup, so there is no path on which a pending timer keeps the process
     * alive after the job settles.
     */
    let response: Response;
    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers: { [INTERNAL_TRIGGER_HEADER]: secret },
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      });
    } catch (error) {
      /*
       * **The error is described, never logged.** A `fetch` failure can carry the
       * request — headers included — on `cause`, and this one's headers hold the
       * shared secret. `name` and the target are what a person needs: an
       * `AbortError` is the timeout, a `TypeError` is DNS or a refused connection,
       * and both are answered the same way.
       *
       * Rethrown so BullMQ marks the job failed. There is no retry configured and
       * that is deliberate — the next tick is fifteen minutes away, the work is
       * idempotent, and a retry storm against an API that is down costs more than
       * waiting.
       */
      logger.error('expiry trigger could not reach the API', {
        target,
        reason: error instanceof Error ? error.name : 'unknown',
      });

      /*
       * **The cause is attached, and the secret is kept out by the logging layer
       * rather than by omission here.** The first version of this dropped the cause
       * on purpose — a `fetch` rejection can carry the whole request, headers
       * included, and `redact` recurses into `cause`. But dropping it also loses the
       * only useful diagnostic (`ECONNREFUSED`, `ENOTFOUND`, the address), and the
       * `preserve-caught-error` lint rule refused it, correctly.
       *
       * The resolution is at the layer built for it: `x-internal-trigger` is in
       * `SENSITIVE_KEY_PATTERNS`, so the header is redacted **wherever** it appears
       * — here, in the worker's `failed` handler, and in anything written later that
       * nobody has thought about yet. Fixing it only in this file would have left
       * the next path open.
       */
      throw new Error('expiry trigger failed to reach the API', { cause: error });
    }

    if (!response.ok) {
      /*
       * A 401 here means the two halves of ADR 0048 disagree about the secret — the
       * commonest way this breaks, and worth being able to read off one line. The
       * body is deliberately not included: it is ours, but a response body is the
       * one part of this exchange nothing has validated.
       */
      logger.error('expiry trigger was refused', { target, status: response.status });
      throw new Error(`expiry trigger returned ${String(response.status)}`);
    }

    /*
     * Parsed loosely and on purpose. The worker does not own this contract, and a
     * strict parse here would make a *successful* sweep fail the job because a
     * field it only logs had changed shape. `@platform/contracts` has the strict
     * schema for callers that act on the answer; this one narrates it.
     */
    const result = (await response.json()) as SweepResult;
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
       * The batch filled, so more may be waiting. **Deliberately not
       * self-enqueued**: at 500 a sweep and four sweeps an hour this drains 2,000
       * requests an hour against a platform that has six bookings, and a job that
       * queues itself is a recursion worth avoiding until the arithmetic says
       * otherwise. `warn` because it is the one outcome that means *look*.
       */
      logger.warn('expiry sweep filled its batch; more may remain', { expired });
    }
  };
}
