/**
 * Asking the API who the current user is, and surviving every way that can go
 * wrong.
 *
 * Separated from the page that renders it for the same reason as
 * `readiness.ts`: the interesting cases are not the happy path. The API can be
 * unreachable, can answer 401 because the token expired between render and
 * fetch, or can answer with a shape this version does not understand mid-deploy.
 * None of those should reach a person as a blank screen, and a signed-in user
 * seeing "signed out" because the API was briefly down would be a lie.
 *
 * `fetch` is injected so all of it is testable without a server.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  ME_PATH,
  parseMeResponse,
} from '@platform/contracts';
import type { MeResponse } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

/**
 * How long the API has to answer before the page gives up.
 *
 * Shorter than the readiness budget: this call does no dependency probing, it
 * reads one row. An engineering constant describing how long a page render may
 * block, not a business rule.
 */
export const ACCOUNT_TIMEOUT_MS = 3_000;

export type AccountOutcome =
  | { readonly kind: 'signed-in'; readonly account: MeResponse }
  /** The API rejected the token, or there was no token to send. */
  | { readonly kind: 'signed-out' }
  /**
   * **Authenticated, and refused anyway — a decision, not an outage.**
   *
   * A 403 means the API understood us and said no. Collapsing it into
   * `unreachable` tells somebody the site broke when what happened was a
   * decision about their account, and that sentence is the one this whole
   * change exists to delete. `/me` opts in to `@AllowsSuspended`, so today
   * nothing can produce one here — but the next `/me` route that does not opt
   * in would have inherited the wrong sentence silently, which is precisely how
   * the profile form came to say it.
   */
  | { readonly kind: 'forbidden' }
  /** No answer at all: refused, DNS failure, or too slow. */
  | { readonly kind: 'unreachable'; readonly reason: string }
  /** It answered, but not with something this version understands. */
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
      ? `no response within ${ACCOUNT_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

/**
 * Read the signed-in account.
 *
 * A null token short-circuits rather than making a request the API will
 * certainly reject — signed out is a normal state, not an error, and a round
 * trip to be told so is wasted on every anonymous page view.
 */
export async function fetchAccount(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  /**
   * Forwarded so the audit log can record where a first sign-in came from —
   * `account.provisioned` fires on whichever authenticated request happens to
   * be first, which is often this one. Null when there is no proxy in front.
   */
  clientIp: string | null = null,
): Promise<AccountOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  const url = new URL(ME_PATH, apiBaseUrl).toString();

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        // One id for the whole page view, so `/me` and `/me/profile` — which
        // this page reads concurrently — say in the logs that they came from
        // the same browser request. See `correlation.ts`.
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  // 401 is the API's answer, not a failure. Session tokens are short-lived — the
  // instance issues them with a 60-second lifetime — so one expiring between
  // render and fetch is routine rather than exceptional.
  if (response.status === 401) return { kind: 'signed-out' };

  // Not folded into either neighbour. It is not `signed-out`, because this
  // token was accepted and telling somebody to sign in again sends them round a
  // loop that cannot end; and it is not `unreachable`, because the API answered
  // perfectly well. It is an answer we have to render as one.
  if (response.status === 403) return { kind: 'forbidden' };

  // Anything else non-2xx is our problem, not the user's, and must not be
  // rendered as "signed out": telling a signed-in person they are signed out
  // because the API returned 500 invites them to sign in again and again.
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
    // Almost always a proxy error page rather than the API. Keep a short
    // excerpt: the full body could be a whole HTML document.
    return {
      kind: 'malformed',
      reason: `expected JSON, got ${raw.trim().slice(0, 80) || '(empty response)'}`,
    };
  }

  try {
    return { kind: 'signed-in', account: parseMeResponse(parsed) };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
