/**
 * Listings, as an administrator moderates them (slice 2.8c-i).
 *
 * **Its own module rather than two more exports in `listings.ts`, and the
 * separation is the same security boundary the API drew** (ADR 0041). Everything
 * in `listings.ts` is owner-scoped: every call there reaches the caller's own
 * listing and answers 404 for anybody else's, so a mistake in it is contained by
 * the ownership filter in the query. This call has no such filter behind it —
 * moderating is *reaching into a stranger's listing on purpose* — and the role
 * with its second factor is the entire control.
 *
 * `AdminListingsController` is a separate file for exactly that reason, on the
 * grounds that a moderation route filed among owner routes is one somebody later
 * copies without the `@Roles`. The same is true one layer out: a moderation
 * *call* filed among owner calls is one somebody copies without noticing which
 * listings it can touch.
 *
 * The outcome union keeps the member names every other admin module uses, minus
 * the cases this route cannot produce — there is no slug to collide, no
 * completeness gate to fail and no kill switch in front of it. Two vocabularies
 * for "the API said no" is how one of them ends up handled differently for no
 * reason.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  adminListingModerationPath,
  parseModerationOutcome,
} from '@platform/contracts';
import type { ModerationOutcome, ModerationState } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

export const ADMIN_LISTINGS_TIMEOUT_MS = 5_000;

export type AdminListingOutcome<T> =
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
      ? `no response within ${String(ADMIN_LISTINGS_TIMEOUT_MS)}ms`
      : error.message;
  }
  return String(error);
}

/**
 * The API's `issues` out of a 400 body, without trusting its shape.
 *
 * Both of this route's 400s carry them: a malformed decision from the contract
 * parser, and a hiding state with no reason from the service. The form shows
 * them because the API is the only thing that knows which of the two happened.
 */
function readIssues(raw: string): readonly string[] | undefined {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) return undefined;

    const { issues } = body as { issues?: unknown };
    return Array.isArray(issues) ? (issues as readonly string[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record what the platform permits of a listing (§8.3, §9, ADR 0041).
 *
 * `PUT`, matching the route: the decision replaces whatever the last one was,
 * and re-sending it is the same decision. That is what makes a double-submitted
 * form harmless here.
 *
 * **The reason is sent as `null` rather than omitted when it is empty.** The
 * schema treats a blank string as absent, so both spellings work today — and
 * being explicit means a reinstatement is visibly a decision with no reason
 * attached rather than a request that forgot the field.
 *
 * `moderationState` comes back **parsed**, and the caller renders that rather
 * than the state it submitted. A page that echoes its own request cannot report
 * a decision the platform recorded differently.
 */
export async function moderateListing(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  state: ModerationState,
  reason: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<AdminListingOutcome<ModerationOutcome>> {
  if (token === null || token === '') return { kind: 'signed-out' };

  const url = new URL(adminListingModerationPath(listingId), apiBaseUrl).toString();

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      signal: AbortSignal.timeout(ADMIN_LISTINGS_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
      cache: 'no-store',
      body: JSON.stringify({ state, reason }),
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status === 403) return { kind: 'forbidden' };
  if (response.status === 404) return { kind: 'not-found' };

  if (response.status === 400) {
    return {
      kind: 'invalid',
      issues: readIssues(await response.text()) ?? ['The decision was rejected'],
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
    return { kind: 'loaded', value: parseModerationOutcome(JSON.parse(raw)) };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
