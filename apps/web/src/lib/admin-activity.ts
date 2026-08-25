/**
 * Reading another account's activity, as an administrator.
 *
 * Separate from `activity.ts` on purpose. The two call different endpoints with
 * different authority, and one file serving both would make it easy to reach
 * the administrative one by passing an extra argument — which is exactly the
 * shape of mistake this module exists to prevent.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  adminActivityPath,
  parseActivityResponse,
} from '@platform/contracts';
import type { ActivityEntry } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

export const ADMIN_ACTIVITY_TIMEOUT_MS = 5_000;

export type AdminActivityOutcome =
  | { readonly kind: 'loaded'; readonly entries: readonly ActivityEntry[] }
  | { readonly kind: 'signed-out' }
  /** Authenticated, but not an administrator — or without a recent second factor. */
  | { readonly kind: 'forbidden' }
  /** The reason or the account id was rejected. */
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
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
      ? `no response within ${ADMIN_ACTIVITY_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function fetchAdminActivity(
  apiBaseUrl: string,
  token: string | null,
  userId: string,
  reason: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminActivityOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(
      new URL(adminActivityPath(userId, reason), apiBaseUrl).toString(),
      {
        signal: AbortSignal.timeout(ADMIN_ACTIVITY_TIMEOUT_MS),
        headers: {
          [AUTHORIZATION_HEADER]: `Bearer ${token}`,
          ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
          ...(await correlationHeaders()),
          ...(await accessAssertionHeaders()),
        },
      },
    );
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };

  // Distinct from signed-out, because the remedy is different: this person is
  // authenticated and either lacks the role or needs to verify a second factor.
  if (response.status === 403) return { kind: 'forbidden' };

  if (response.status === 400) {
    let issues: readonly string[] = ['The request was rejected'];
    try {
      const body: unknown = JSON.parse(await response.text());
      if (
        typeof body === 'object' &&
        body !== null &&
        'issues' in body &&
        Array.isArray((body as { issues: unknown }).issues)
      ) {
        issues = (body as { issues: readonly string[] }).issues;
      }
    } catch {
      // Keep the default. A 400 whose body cannot be read is still a 400.
    }
    return { kind: 'invalid', issues };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `API answered ${String(response.status)}` };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  try {
    return { kind: 'loaded', entries: parseActivityResponse(JSON.parse(raw)).entries };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
