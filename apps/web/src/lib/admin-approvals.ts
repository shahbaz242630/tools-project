/**
 * Dual approval, from the web app's side.
 *
 * Its own module rather than a branch inside `admin-user.ts`, for the reason
 * that file is separate from `activity.ts`: these are the only calls that
 * *change* anything an administrator can reach, and a module that could both
 * read and write is one where a wrong argument becomes a write.
 */

import {
  ADMIN_APPROVALS_PATH,
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  adminApprovalDecisionPath,
  parseAdminApproval,
  parseAdminApprovalList,
} from '@platform/contracts';
import type { AdminApprovalView, UserRole } from '@platform/contracts';

export const ADMIN_APPROVALS_TIMEOUT_MS = 5_000;

/**
 * `refused` is separate from `invalid` on purpose.
 *
 * `invalid` means the request was malformed and retyping fixes it. `refused`
 * means the request was fine and the world disagreed — you proposed this
 * yourself, somebody already decided it, or it would leave no administrator.
 * Collapsing them would tell an administrator to correct a form that is
 * already correct.
 */
export type AdminApprovalOutcome<T> =
  | { readonly kind: 'loaded'; readonly value: T }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'refused'; readonly reason: string }
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
  },
) => Promise<FetchResponse>;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${ADMIN_APPROVALS_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

/** Pull `message` or `issues` out of an error body without trusting its shape. */
function readError(raw: string): { message?: string; issues?: readonly string[] } {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) return {};

    const record = body as { message?: unknown; issues?: unknown };
    return {
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
      ...(Array.isArray(record.issues)
        ? { issues: record.issues as readonly string[] }
        : {}),
    };
  } catch {
    return {};
  }
}

async function call<T>(
  url: string,
  token: string | null,
  clientIp: string | null,
  fetchImpl: FetchLike,
  parse: (raw: unknown) => T,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<AdminApprovalOutcome<T>> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      signal: AbortSignal.timeout(ADMIN_APPROVALS_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status === 403) return { kind: 'forbidden' };
  if (response.status === 404) return { kind: 'not-found' };

  if (response.status === 409) {
    const { message } = readError(await response.text());
    return { kind: 'refused', reason: message ?? 'That is no longer possible.' };
  }

  if (response.status === 400) {
    const { issues } = readError(await response.text());
    return { kind: 'invalid', issues: issues ?? ['The request was rejected'] };
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

export function fetchPendingApprovals(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminApprovalOutcome<readonly AdminApprovalView[]>> {
  return call(
    new URL(ADMIN_APPROVALS_PATH, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    (raw) => parseAdminApprovalList(raw).approvals,
  );
}

export function proposeRoleChange(
  apiBaseUrl: string,
  token: string | null,
  proposal: { userId: string; role: UserRole; reason: string },
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminApprovalOutcome<AdminApprovalView>> {
  return call(
    new URL(ADMIN_APPROVALS_PATH, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseAdminApproval,
    { method: 'POST', body: proposal },
  );
}

export function decideApproval(
  apiBaseUrl: string,
  token: string | null,
  id: string,
  decision: 'approve' | 'cancel',
  reason: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminApprovalOutcome<AdminApprovalView>> {
  return call(
    new URL(adminApprovalDecisionPath(id, decision), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseAdminApproval,
    { method: 'POST', body: { reason } },
  );
}
