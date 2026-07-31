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

export const ACTIVITY_TIMEOUT_MS = 3_000;

export type ActivityOutcome =
  | { readonly kind: 'loaded'; readonly entries: readonly ActivityEntry[] }
  | { readonly kind: 'signed-out' }
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
      },
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };

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
