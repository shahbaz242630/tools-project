/**
 * Reading the signed-in person's own account activity.
 *
 * Same failure-handling discipline as `account.ts` and `profile.ts`: the
 * interesting cases are not the happy path, and none of them should reach a
 * person as a blank screen. One difference in emphasis — an empty activity list
 * and an activity list that could not be loaded must never render the same,
 * because "nothing has happened on your account" is a security claim.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  ME_ACTIVITY_PATH,
  parseActivityResponse,
} from '@platform/contracts';
import type { ActivityEntry } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

export const ACTIVITY_TIMEOUT_MS = 3_000;

export type ActivityOutcome =
  | { readonly kind: 'loaded'; readonly entries: readonly ActivityEntry[] }
  | { readonly kind: 'signed-out' }
  /**
   * **Authenticated, and refused anyway — a decision, not an outage.**
   *
   * `profile.ts` grew one of these because a 403 means the API understood us
   * and said no, and calling that `unreachable` tells somebody the site broke
   * when what happened was a decision about their account. `/me/activity` opts
   * in to `@AllowsSuspended` so nothing can produce one today — but the copy
   * was wrong in advance, and the next route that does not opt in would have
   * inherited it silently.
   *
   * It matters more here than on most routes: the branch this would otherwise
   * have fallen into is the one that says the list *could not be read*, and
   * this page's whole discipline is that a list which could not be read must
   * never be confused with a list of nothing. A refusal is a third thing again.
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
      ? `no response within ${ACTIVITY_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function fetchActivity(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ActivityOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(new URL(ME_ACTIVITY_PATH, apiBaseUrl).toString(), {
      signal: AbortSignal.timeout(ACTIVITY_TIMEOUT_MS),
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
    return { kind: 'loaded', entries: parseActivityResponse(parsed).entries };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
