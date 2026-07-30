/**
 * Forwarding a verified Clerk webhook inward to the API.
 *
 * The web app's role here is narrow and worth stating: it verifies the Standard
 * Webhooks signature — it is the only process on the edge network, and the raw
 * unparsed body exists only here — and then hands the event to the API, which
 * owns what the event *means* and is the only service that can write.
 *
 * Deliberately not interpreting the payload. Clerk's event shape is understood
 * in exactly one place, the API's identity module, so a change to it is one
 * edit rather than two services that have to be changed together.
 */

import { CLERK_EVENTS_PATH, clerkEventResultSchema } from '@platform/contracts';
import type { ClerkEventResult } from '@platform/contracts';

/**
 * How long the API has to accept the event.
 *
 * Generous relative to a page render, because the cost of being wrong is
 * asymmetric: giving up early makes Clerk retry a delivery the API may have
 * already applied, and while that is safe — the ledger makes it idempotent — it
 * is noise that looks like a fault.
 */
export const FORWARD_TIMEOUT_MS = 10_000;

export type ForwardOutcome =
  | { readonly kind: 'accepted'; readonly result: ClerkEventResult }
  /**
   * The API refused the payload. Not retryable: the same body will be refused
   * again, so the caller should answer Clerk with a 4xx and stop the retries.
   */
  | { readonly kind: 'rejected'; readonly reason: string }
  /**
   * The API could not be reached or failed. Retryable — the caller should answer
   * Clerk with a 5xx so the delivery comes back.
   */
  | { readonly kind: 'failed'; readonly reason: string };

export interface ForwardResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    body: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<ForwardResponse>;

export interface IdentityEventForward {
  readonly deliveryId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${FORWARD_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function forwardIdentityEvent(
  apiBaseUrl: string,
  forward: IdentityEventForward,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ForwardOutcome> {
  const url = new URL(CLERK_EVENTS_PATH, apiBaseUrl).toString();

  let response: ForwardResponse;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      body: JSON.stringify(forward),
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'failed', reason: describe(error) };
  }

  // 4xx and 5xx are separated because they need opposite answers to Clerk. A
  // payload the API cannot map will never map, so retrying it forever is pure
  // noise; a 500 or an unreachable API is exactly what retries are for.
  if (response.status >= 400 && response.status < 500) {
    return { kind: 'rejected', reason: `API answered ${String(response.status)}` };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'failed', reason: `API answered ${String(response.status)}` };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return { kind: 'failed', reason: describe(error) };
  }

  try {
    return { kind: 'accepted', result: clerkEventResultSchema.parse(JSON.parse(raw)) };
  } catch {
    // The API answered 2xx, so the event *was* accepted; we simply cannot read
    // what it said about it. Reporting accepted rather than failed is the
    // deliberate choice: asking Clerk to redeliver something already applied
    // would be acting on a claim we have no evidence for. The ledger would
    // absorb the duplicate, but the retry storm would look like a fault.
    return { kind: 'accepted', result: { outcome: 'applied' } };
  }
}
