/**
 * Categories, from the web app's side.
 *
 * Its own module rather than a branch inside `admin-approvals.ts`, for the
 * reason that file gives about `admin-user.ts`: those are calls about a person,
 * and these are calls about configuration. They will diverge — from slice 2.10
 * a category is read by anyone with a browser, and a module that already knew
 * how to change one would be the wrong thing to reach for on a public page.
 *
 * The outcome union is deliberately the same shape as `AdminApprovalOutcome`.
 * Two vocabularies for "the API said no" is how one of them ends up handled
 * differently for no reason.
 */

import {
  ADMIN_CATEGORIES_ROUTE,
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  adminCategoryPath,
  parseAdminCategory,
  parseAdminCategoryList,
} from '@platform/contracts';
import type {
  AdminCategory,
  CategoryConfigurationInput,
  CategoryDraftInput,
} from '@platform/contracts';
import { correlationHeaders } from './correlation';

export const ADMIN_CATEGORIES_TIMEOUT_MS = 5_000;

/**
 * `taken` is separate from `invalid` on purpose.
 *
 * `invalid` means the slug is malformed and retyping the same idea fixes it.
 * `taken` means it was well formed and something already has it — a different
 * fix, and telling somebody to correct a field that is already correct is the
 * failure this distinction avoids.
 */
export type AdminCategoryOutcome<T> =
  | { readonly kind: 'loaded'; readonly value: T }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'taken'; readonly reason: string }
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
      ? `no response within ${String(ADMIN_CATEGORIES_TIMEOUT_MS)}ms`
      : error.message;
  }
  return String(error);
}

/**
 * Pull `message` or `issues` out of an error body without trusting its shape.
 *
 * **The status still decides the outcome and always did; what changed is that
 * the body is no longer thrown away when this fails to understand it.** The
 * `catch` returned `{}`, and so did a parse that succeeded and found neither
 * key — so an error page from something in front of the API, or a message under
 * a key we do not read, reached an administrator as a generic fallback with no
 * trace anywhere that anything else had been said. That is the failure mode
 * hardest to diagnose later: the sentence on screen is plausible, and the real
 * one no longer exists.
 *
 * `unreadable` is what was there instead, and it is deliberately **absent for an
 * empty body** — there is nothing to lose when nothing was sent, and appending
 * "the service also said: nothing" to a fallback would be noise on the common
 * case.
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

  // Parsed, and said nothing in a vocabulary this knows. Same loss as a body
  // that would not parse at all, so the same answer.
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
): Promise<AdminCategoryOutcome<T>> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      signal: AbortSignal.timeout(ADMIN_CATEGORIES_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        ...(await correlationHeaders()),
      },
      // Configuration an administrator has just changed must not be served from
      // a cache that still holds the previous version.
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status === 403) return { kind: 'forbidden' };
  if (response.status === 404) return { kind: 'not-found' };

  if (response.status === 409) {
    const { message, unreadable } = readError(await response.text());
    return {
      kind: 'taken',
      reason: message ?? withUnread('That slug is already in use.', unreadable),
    };
  }

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

export function fetchCategories(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminCategoryOutcome<readonly AdminCategory[]>> {
  return call(
    new URL(ADMIN_CATEGORIES_ROUTE, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    (raw) => parseAdminCategoryList(raw).categories,
  );
}

export function createCategory(
  apiBaseUrl: string,
  token: string | null,
  draft: CategoryDraftInput,
  reason: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminCategoryOutcome<AdminCategory>> {
  const url = new URL(ADMIN_CATEGORIES_ROUTE, apiBaseUrl);
  url.searchParams.set('reason', reason);

  return call(url.toString(), token, clientIp, fetchImpl, parseAdminCategory, {
    method: 'POST',
    body: draft,
  });
}

export function reconfigureCategory(
  apiBaseUrl: string,
  token: string | null,
  slug: string,
  configuration: CategoryConfigurationInput,
  reason: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminCategoryOutcome<AdminCategory>> {
  const url = new URL(adminCategoryPath(slug), apiBaseUrl);
  url.searchParams.set('reason', reason);

  return call(url.toString(), token, clientIp, fetchImpl, parseAdminCategory, {
    method: 'PUT',
    body: configuration,
  });
}
