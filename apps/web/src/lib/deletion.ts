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

export const DELETION_TIMEOUT_MS = 5_000;

export type DeletionOutcome =
  | { readonly kind: 'deleted' }
  /** No token, or the API refused it. Nothing was done. */
  | { readonly kind: 'signed-out' }
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
      },
    });
  } catch (error) {
    return { kind: 'uncertain', reason: describe(error) };
  }

  // 401 here is unambiguous: the API refused before doing anything. It also
  // covers the repeat case — a second request from an already-deleted account
  // cannot authenticate, which means the first one worked.
  if (response.status === 401) return { kind: 'signed-out' };

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
