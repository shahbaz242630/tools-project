/**
 * Feature flags, from the web app's side.
 *
 * Its own module rather than a branch in `admin-categories.ts`, for the reason
 * that file gives about `admin-user.ts`: those are calls about configuration a
 * category carries, and these are calls about whether the platform is doing a
 * thing at all. They share a shape and nothing else.
 *
 * The outcome union is deliberately the same shape as `AdminCategoryOutcome`,
 * minus the two cases that cannot happen here — there is no slug to collide, and
 * `not-found` means "this build does not declare that flag" rather than "no such
 * row". Two vocabularies for "the API said no" is how one of them ends up
 * handled differently for no reason.
 */

import {
  ADMIN_FEATURE_FLAGS_ROUTE,
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  adminFeatureFlagPath,
  parseAdminFeatureFlag,
  parseAdminFeatureFlags,
} from '@platform/contracts';
import type { AdminFeatureFlag } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

export const ADMIN_FEATURE_FLAGS_TIMEOUT_MS = 5_000;

export type AdminFeatureFlagOutcome<T> =
  | { readonly kind: 'loaded'; readonly value: T }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export interface FetchResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    body?: string;
    cache?: string;
  },
) => Promise<FetchResponse>;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${String(ADMIN_FEATURE_FLAGS_TIMEOUT_MS)}ms`
      : error.message;
  }
  return String(error);
}

/**
 * Pull `issues` or `message` out of an error body without trusting its shape.
 *
 * **The status still decides the outcome and always did; what changed is that
 * the body is no longer thrown away when this fails to understand it.** It
 * returned `undefined` from the `catch` and from a parse that found no `issues`
 * array, so a message under any other key — including the single `message`
 * string Nest sends for most refusals — reached an administrator as "the request
 * was rejected" with nothing anywhere recording what had actually been said.
 * This is the kill-switch client: the person reading that sentence is usually
 * mid-incident, and the detail they lost is the one that explains it.
 *
 * `unreadable` is deliberately absent for an empty body — nothing was sent, so
 * nothing was lost.
 */
function readError(raw: string): {
  message?: string;
  issues?: readonly string[];
  unreadable?: string;
} {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Almost always a proxy error page rather than the API.
    return unreadable(raw);
  }

  if (typeof body !== 'object' || body === null) return unreadable(raw);

  const record = body as { message?: unknown; issues?: unknown };
  const read = {
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(Array.isArray(record.issues)
      ? { issues: record.issues as readonly string[] }
      : {}),
  };

  return 'message' in read || 'issues' in read ? read : unreadable(raw);
}

/** A short excerpt of a body we could not read, or nothing when there was none. */
function unreadable(raw: string): { unreadable?: string } {
  const trimmed = raw.trim();
  // A short excerpt only — the full body could be an entire HTML document.
  return trimmed === '' ? {} : { unreadable: trimmed.slice(0, 80) };
}

/**
 * The fallback sentence, and whatever the service said instead of a body we
 * could read. One or the other, never neither.
 */
function withUnread(fallback: string, unread: string | undefined): string {
  return unread === undefined ? fallback : `${fallback} (the service said: ${unread})`;
}

async function call<T>(
  url: string,
  token: string | null,
  clientIp: string | null,
  fetchImpl: FetchLike,
  parse: (raw: unknown) => T,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<AdminFeatureFlagOutcome<T>> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      signal: AbortSignal.timeout(ADMIN_FEATURE_FLAGS_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
      // **Never cached, and here it matters more than anywhere else in the app.**
      // A kill switch read from a cache is one that appears not to have worked,
      // and the administrator's response to that during an incident is to throw
      // it again.
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status === 403) return { kind: 'forbidden' };
  if (response.status === 404) return { kind: 'not-found' };

  if (response.status === 400) {
    const { message, issues, unreadable } = readError(await response.text());
    return {
      kind: 'invalid',
      issues: issues ?? [message ?? withUnread('The request was rejected', unreadable)],
    };
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
    return { kind: 'loaded', value: parse(JSON.parse(raw)) };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}

export function fetchFeatureFlags(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminFeatureFlagOutcome<readonly AdminFeatureFlag[]>> {
  return call(
    new URL(ADMIN_FEATURE_FLAGS_ROUTE, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    (raw) => parseAdminFeatureFlags(raw).flags,
  );
}

export function setFeatureFlag(
  apiBaseUrl: string,
  token: string | null,
  key: string,
  enabled: boolean,
  reason: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminFeatureFlagOutcome<AdminFeatureFlag>> {
  const url = new URL(adminFeatureFlagPath(key), apiBaseUrl);
  url.searchParams.set('reason', reason);

  return call(url.toString(), token, clientIp, fetchImpl, parseAdminFeatureFlag, {
    method: 'PUT',
    body: { enabled },
  });
}
