/**
 * Asking the API whether it is ready, and surviving every way that can go wrong.
 *
 * Separated from the page that renders it because the interesting cases are not
 * the happy path. The API can be unreachable, can answer with something that is
 * not JSON, can answer with JSON of the wrong shape mid-deploy, or can take so
 * long that a page render hangs. Each needs a different thing shown to the user,
 * and none of them should surface as a blank screen.
 *
 * `fetch` is injected so all of that is testable without a server.
 */

import { parseReadyResponse, READY_PATH } from '@platform/contracts';
import type { DependencyStatus } from '@platform/contracts';

/**
 * How long the API has to answer before the page gives up.
 *
 * An engineering constant, not configuration: it describes how long a page
 * render may block, which is a property of being a web page rather than a
 * business rule that changes without a deploy. The API's own readiness check
 * budgets 2s per dependency, so this sits above that — otherwise we would time
 * out while it was still legitimately working.
 */
export const READINESS_TIMEOUT_MS = 5_000;

export type ReadinessOutcome =
  | { readonly kind: 'ready'; readonly checks: Record<string, DependencyStatus> }
  | { readonly kind: 'not_ready'; readonly checks: Record<string, DependencyStatus> }
  /** No answer at all: refused, DNS failure, or too slow. */
  | { readonly kind: 'unreachable'; readonly reason: string }
  /** It answered, but not with something this version understands. */
  | { readonly kind: 'malformed'; readonly reason: string };

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ text: () => Promise<string> }>;

function describe(error: unknown): string {
  if (error instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError whose message is unhelpful
    // on its own; say what actually happened.
    return error.name === 'TimeoutError'
      ? `no response within ${READINESS_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

/**
 * Read the API's readiness.
 *
 * Deliberately does not branch on the HTTP status. The API answers 503 when a
 * dependency is down, with a perfectly valid body describing which one —
 * treating that as a failure would throw away the only useful part.
 */
export async function fetchReadiness(
  apiBaseUrl: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ReadinessOutcome> {
  const url = new URL(READY_PATH, apiBaseUrl).toString();

  let raw: string;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    });
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
    const report = parseReadyResponse(parsed);
    return report.status === 'ready'
      ? { kind: 'ready', checks: report.checks }
      : { kind: 'not_ready', checks: report.checks };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
