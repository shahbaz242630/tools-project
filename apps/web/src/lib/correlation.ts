/**
 * The correlation id for the browser request currently being served.
 *
 * **The defect this closes.** BRD §9 requires a failure to be traceable across
 * the frontend, the API, the workers and the provider adapters, and the API has
 * honoured an inbound `x-correlation-id` since Phase 0 — but nothing in
 * `apps/web` had ever sent one. The API therefore minted a fresh id per inbound
 * call, so a single page render fanned out into several unrelated traces and no
 * browser request could be followed across the one hop that matters. Every log
 * line was correlated with the others from the same *API call* and with nothing
 * else, which is the appearance of correlation rather than correlation.
 *
 * **One id per inbound request, not per outgoing call.** Minting inside each
 * client would have satisfied the letter of "send a correlation id" and
 * recreated the same defect one layer up: `/account` alone reads `/me` and
 * `/me/profile` concurrently, and `/account/activity` reads two more. The point
 * of the id is that those four lines say they came from one page view.
 *
 * **How the id is made request-scoped, and why not the obvious way.** Next 16's
 * documented per-request memoization is React's `cache()`, and it is the wrong
 * tool here: outside a React render it has no dispatcher and silently degrades
 * to calling the function again — so a Server Action or a Route Handler would
 * mint a fresh id per call with nothing failing. `headers()` gives a stronger
 * guarantee for free. It resolves to the request store's own `Headers` object,
 * the same instance for the life of the request in every server context, which
 * Next itself relies on by keying a `WeakMap` on it. Keying ours on the same
 * object inherits exactly the scope we want, needs no framework internals, and
 * lets go of the entry when the request does.
 *
 * **An inbound id wins.** When something in front of us has already started a
 * trace, continuing it is the whole purpose — and it is sanitised first, on the
 * same reasoning as the API's own middleware: the value is attacker-controlled
 * and lands in logs, where an unchecked newline lets a caller forge log entries.
 *
 * **Outside a request there is no id, and that is not a failure.** A unit test
 * calling one of these clients directly has no request store, so `headers()`
 * throws; the header is then simply absent, which is honest. Minting one would
 * put an id in a log that correlates a single call with nothing.
 */

import { headers } from 'next/headers';

/**
 * Must stay identical to `CORRELATION_HEADER` in
 * `apps/api/src/observability/correlation.middleware.ts`, which is what reads
 * it. The two are separate constants because this app does not depend on
 * `@platform/observability` — its natural home is `@platform/contracts`, beside
 * `AUTHORIZATION_HEADER` and `CLIENT_IP_HEADER`, and moving it there is a
 * change to a package this slice does not own.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Keyed on the request's own `Headers` object rather than on anything we own.
 *
 * A `WeakMap` because the key is the framework's and its lifetime is the
 * request's: when Next lets go of the request store this entry goes with it,
 * with nothing to expire and no way to leak an id into the next request.
 */
const mintedForRequest = new WeakMap<object, string>();

/**
 * Accepts an inbound id only if it looks like one.
 *
 * Deliberately the same rule as `sanitiseCorrelationId` in
 * `@platform/observability`: 128 characters at most, and nothing outside
 * `[A-Za-z0-9_-]`. A duplicated rule is worth less than a shared one, but a
 * shared one here would mean this browser-facing app taking a dependency that
 * pulls in `prom-client` and a Node logger.
 */
function sanitise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * The id for this request, or null when there is no request.
 *
 * Exported for its tests. Callers want `correlationHeaders`, which is what
 * makes "send it on every outbound call" a single spread rather than a
 * conditional each client has to get right.
 */
export async function currentCorrelationId(): Promise<string | null> {
  let inbound: Awaited<ReturnType<typeof headers>>;
  try {
    inbound = await headers();
  } catch {
    // No request store: a unit test, or a module loaded outside a render. The
    // absence of an id is the correct answer, not a swallowed error.
    return null;
  }

  const forwarded = sanitise(inbound.get(CORRELATION_HEADER));
  if (forwarded !== null) return forwarded;

  const already = mintedForRequest.get(inbound);
  if (already !== undefined) return already;

  const minted = crypto.randomUUID();
  mintedForRequest.set(inbound, minted);
  return minted;
}

/**
 * The correlation header, ready to spread into an outbound request.
 *
 * Returns an empty object rather than an empty header when there is no id, for
 * the reason `authHeaders` omits an unknown client IP: a blank value in a
 * request log invites the reader to believe it was measured and found to be
 * nothing.
 */
export async function correlationHeaders(): Promise<Record<string, string>> {
  const id = await currentCorrelationId();
  return id === null ? {} : { [CORRELATION_HEADER]: id };
}
