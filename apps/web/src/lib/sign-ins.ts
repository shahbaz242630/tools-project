/**
 * Reading the signed-in person's own sign-in history.
 *
 * The same failure discipline as `activity.ts`, and for the same reason
 * sharpened: **an empty list and a list that failed to load must never render
 * the same.** "No other device has signed in" is a security claim, and showing
 * it because a fetch timed out would be the most misleading thing this page
 * could do.
 *
 * Shaped like its sibling rather than factored together with it. The two call
 * different endpoints with different outcome types, and the duplication here is
 * of a pattern this app already repeats deliberately in `account.ts`,
 * `profile.ts` and `deletion.ts` — each one owns its own failure vocabulary.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  ME_SIGN_INS_PATH,
  parseSignInsResponse,
} from '@platform/contracts';
import type { SignInEntry } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

export const SIGN_INS_TIMEOUT_MS = 3_000;

export type SignInsOutcome =
  | { readonly kind: 'loaded'; readonly entries: readonly SignInEntry[] }
  | { readonly kind: 'signed-out' }
  /**
   * **Authenticated, and refused anyway**, for the reason written out in
   * `activity.ts`: a 403 is the API understanding us and refusing, which is not
   * an outage and must not be worded as one. The comment further down about not
   * folding 403 into `signed-out` was right and is not the same point — the fix
   * was a third member, not a second meaning for an existing one.
   */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export interface FetchResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${SIGN_INS_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function fetchSignIns(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<SignInsOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(new URL(ME_SIGN_INS_PATH, apiBaseUrl).toString(), {
      signal: AbortSignal.timeout(SIGN_INS_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };

  // 403 is not folded into `signed-out`. A suspended account reaches this route
  // — it is one of the five that opt in — so a 403 here means something else
  // went wrong, and reporting it as "sign in again" would send somebody round a
  // loop that cannot end. It is not folded into the catch-all below either:
  // that one says the history could not be *read*, which is a claim about us
  // rather than about a decision somebody made.
  if (response.status === 403) return { kind: 'forbidden' };

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `API answered ${String(response.status)}` };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: 'malformed',
      reason: `expected JSON, got ${raw.trim().slice(0, 80) || '(empty response)'}`,
    };
  }

  try {
    return { kind: 'loaded', entries: parseSignInsResponse(parsed).entries };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
