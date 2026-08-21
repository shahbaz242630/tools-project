import type { Logger } from '@platform/observability';

/**
 * Setting off work that lives in the API (slice 5.4b, ADR 0048).
 *
 * **Extracted from `expire-requests.handler.ts` when reconciliation became the
 * second caller** — the rule-of-two call `describeLine` and `InternalTriggerGuard`
 * both got the same day. What made it worth extracting is not the line count: it is
 * that **the delicate part is the secret handling**, and two copies of a subtlety
 * are two chances for one of them to be edited by somebody who has not read the
 * other.
 *
 * ## Why the work is never here
 *
 * Every sweep behind this writes tables owned by an API module and asserts rules
 * that live there — and this process **cannot reach any of it**: it is ESM to the
 * API's CommonJS (ADR 0011) and has no database client. So the worker holds the
 * *schedule's* half of ADR 0048 and nothing else. It knows a path, a header and a
 * timeout.
 *
 * **It deliberately does not interpret the response.** The body comes back loosely
 * typed for a caller to narrate. If anything here ever needs to know what a booking
 * or a payment *is*, something has been put in the wrong process.
 *
 * ## The secret must not reach a log line
 *
 * It is an outbound header, which is the direction that leaks: a `fetch` rejection
 * can carry the whole request — headers included — on `cause`. Two things keep it
 * out, and **both matter**:
 *
 * - The catch logs a **described** error (`name` and target), never the error object.
 * - The cause is still attached to the rethrow, because dropping it loses
 *   `ECONNREFUSED` and the `preserve-caught-error` rule refuses it. What makes that
 *   safe is that **`x-internal-trigger` is in `SENSITIVE_KEY_PATTERNS`**, so
 *   `redact` removes it wherever it surfaces — here, in the worker's `failed`
 *   handler, and in anything written later that nobody has thought about yet.
 *
 * Fixing it only at a call site would leave the next path open. Do not "tidy" the
 * header out of that list, and do not drop the cause to compensate.
 */

export const INTERNAL_TRIGGER_HEADER = 'x-internal-trigger';

/**
 * How long to wait before giving up.
 *
 * **Far shorter than any schedule that uses it**, so a hung request cannot still be
 * in flight when the next tick fires. Concurrent sweeps are harmless — the work is
 * idempotent — but a pile of them waiting on a dead socket is a worker slowly
 * filling with jobs that will never finish.
 *
 * Thirty seconds is generous for a bounded query against a database in the same
 * region. The point is to bound it at all: `fetch` with no signal waits on the OS,
 * which for a black-holed connection is minutes.
 */
export const TRIGGER_TIMEOUT_MS = 30_000;

export interface InternalTriggerOptions {
  /** Where the API is, from `loadWorkerEnv` — validated as a URL at startup. */
  readonly apiBaseUrl: string;
  /** The shared secret, from the shared `loadEnv` (ADR 0048). */
  readonly secret: string;
  /** The `/internal/…` path to call. */
  readonly path: string;
  /** What this trigger is, for the log lines. Two or three words. */
  readonly describedAs: string;
  readonly logger: Logger;
  /** Injected so a test need not stand up an HTTP server. Defaults to global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Call an internal route and hand back whatever it said.
 *
 * Throws when the API could not be reached or refused, so BullMQ marks the job
 * failed. **No retry is configured and that is deliberate**: the next tick is
 * minutes away, the work is idempotent, and a retry storm against an API that is
 * down costs more than waiting.
 */
export function createInternalTrigger(
  options: InternalTriggerOptions,
): () => Promise<unknown> {
  const { apiBaseUrl, secret, path, describedAs, logger, fetchImpl = fetch } = options;

  // Resolved once. `new URL(path, base)` rather than string concatenation, so a
  // trailing slash on the base cannot produce `//internal/...`.
  const target = new URL(path, apiBaseUrl).toString();

  return async function trigger(): Promise<unknown> {
    let response: Response;

    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers: { [INTERNAL_TRIGGER_HEADER]: secret },
        /*
         * `AbortSignal.timeout` rather than a manual controller and timer: it needs
         * no cleanup, so there is no path on which a pending timer keeps the process
         * alive after the job settles.
         */
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      });
    } catch (error) {
      /*
       * **Described, never logged.** `name` and the target are what a person needs:
       * an `AbortError` is the timeout, a `TypeError` is DNS or a refused
       * connection, and both are answered the same way. See the module docblock for
       * why the cause is nonetheless attached to the rethrow.
       */
      logger.error(`${describedAs} could not reach the API`, {
        target,
        reason: error instanceof Error ? error.name : 'unknown',
      });

      throw new Error(`${describedAs} failed to reach the API`, { cause: error });
    }

    if (!response.ok) {
      /*
       * A 401 means the two halves of ADR 0048 disagree about the secret — the
       * commonest way this breaks, and worth reading off one line. The body is
       * deliberately not included: it is ours, but a response body is the one part
       * of this exchange nothing has validated.
       */
      logger.error(`${describedAs} was refused`, { target, status: response.status });
      throw new Error(`${describedAs} returned ${String(response.status)}`);
    }

    /*
     * Parsed loosely and on purpose. The worker does not own these contracts, and a
     * strict parse would make a *successful* sweep fail the job because a field it
     * only logs had changed shape. `@platform/contracts` has the strict schemas for
     * callers that act on the answer; the worker narrates.
     */
    return (await response.json()) as unknown;
  };
}
