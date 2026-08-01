/**
 * Reading another account's state, as an administrator.
 *
 * Separate from `admin-activity.ts` for the reason that file is separate from
 * `activity.ts`: the two call different endpoints disclosing different things,
 * and one module serving both would make it easy to reach the wider one by
 * passing an extra argument.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  adminUserPath,
  parseAdminUserView,
} from '@platform/contracts';
import type { AdminUserView } from '@platform/contracts';

export const ADMIN_USER_TIMEOUT_MS = 5_000;

export type AdminUserOutcome =
  | { readonly kind: 'loaded'; readonly view: AdminUserView }
  | { readonly kind: 'signed-out' }
  /** Authenticated, but not an administrator — or without a recent second factor. */
  | { readonly kind: 'forbidden' }
  /**
   * No such account, or the id was not one of ours.
   *
   * One outcome for both, because the API answers 404 for both — a malformed id
   * and an absent account are the same answer to somebody typing into a box.
   */
  | { readonly kind: 'not-found' }
  /** The reason was rejected. */
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
      ? `no response within ${ADMIN_USER_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function fetchAdminUser(
  apiBaseUrl: string,
  token: string | null,
  userId: string,
  reason: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminUserOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(
      new URL(adminUserPath(userId, reason), apiBaseUrl).toString(),
      {
        signal: AbortSignal.timeout(ADMIN_USER_TIMEOUT_MS),
        headers: {
          [AUTHORIZATION_HEADER]: `Bearer ${token}`,
          ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
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

  if (response.status === 404) return { kind: 'not-found' };

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
    return { kind: 'loaded', view: parseAdminUserView(JSON.parse(raw)) };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
