/**
 * Asking the API to delete the signed-in account.
 *
 * The same failure discipline as the other clients, with the stakes reversed:
 * elsewhere the danger is claiming success when nothing was saved. Here the
 * danger is **claiming failure when the deletion actually happened** — somebody
 * told "that did not work" will try again, and by then they cannot authenticate
 * to try. So an ambiguous outcome says so in those words rather than inviting a
 * retry that cannot succeed.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  ME_DELETION_PATH,
  parseDeletionResponse,
} from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

export const DELETION_TIMEOUT_MS = 5_000;

export type DeletionOutcome =
  | { readonly kind: 'deleted' }
  /** No token, or the API refused it. Nothing was done. */
  | { readonly kind: 'signed-out' }
  /**
   * **Authenticated, and refused anyway — and nothing was deleted.**
   *
   * As unambiguous as `signed-out`: a 403 comes from the guard, before the
   * handler that erases anything runs. That certainty is the reason this is a
   * member of its own rather than an `uncertain` with a different reason —
   * `uncertain` tells somebody to go and check by signing in, and sending a
   * person to check something we already know would be a lie of politeness.
   *
   * Erasure survives suspension by design (ADR 0024), so nothing produces a 403
   * here today. It is branched on anyway, because the alternative — the shape
   * this file carried until now — was a union that could grow without the
   * consumer noticing, on the one code path where not noticing is unrecoverable.
   */
  | { readonly kind: 'forbidden' }
  /**
   * The request may or may not have been applied. Deliberately distinct from a
   * failure: a timeout on a POST is not evidence that nothing happened.
   */
  | { readonly kind: 'uncertain'; readonly reason: string };

export interface FetchResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${DELETION_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function requestDeletion(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<DeletionOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(new URL(ME_DELETION_PATH, apiBaseUrl).toString(), {
      method: 'POST',
      // Longer than the read paths: this one erases rows in a transaction, and
      // giving up early on a write that is still running is how the caller ends
      // up uncertain about something that succeeded.
      signal: AbortSignal.timeout(DELETION_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        // Worth more here than anywhere else: this is the one request whose
        // effects cannot be replayed, so the trace is the only account of it.
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
    });
  } catch (error) {
    return { kind: 'uncertain', reason: describe(error) };
  }

  // 401 here is unambiguous: the API refused before doing anything. It also
  // covers the repeat case — a second request from an already-deleted account
  // cannot authenticate, which means the first one worked.
  if (response.status === 401) return { kind: 'signed-out' };

  // **Read before the catch-all below, and that ordering is the fix.** A 403
  // falling into `uncertain` told somebody we could not tell whether their
  // account had been deleted, when in fact we knew perfectly well that it had
  // not — and the remedy `uncertain` offers, signing in to check, would have
  // shown them an account that still exists and left them no wiser about why.
  if (response.status === 403) return { kind: 'forbidden' };

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'uncertain', reason: `API answered ${String(response.status)}` };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    // The status said success, so it almost certainly happened — but the body
    // could not be read, so this does not claim it did.
    return { kind: 'uncertain', reason: describe(error) };
  }

  try {
    parseDeletionResponse(JSON.parse(raw));
    return { kind: 'deleted' };
  } catch (error) {
    return { kind: 'uncertain', reason: describe(error) };
  }
}
