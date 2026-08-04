/**
 * Listings, from the web app's side.
 *
 * The outcome union is deliberately the same shape as `AdminCategoryOutcome`,
 * minus `taken` — a listing has no unique slug to collide with. Two vocabularies
 * for "the API said no" is how one of them ends up handled differently for no
 * reason.
 */

import {
  AUTHORIZATION_HEADER,
  CATEGORY_OPTIONS_PATH,
  CLIENT_IP_HEADER,
  LISTINGS_PATH,
  listingPath,
  parseCategoryOptions,
  parseOwnerListing,
} from '@platform/contracts';
import type {
  CategoryOption,
  ListingDraftInput,
  OwnerListing,
} from '@platform/contracts';

export const LISTINGS_TIMEOUT_MS = 5_000;

export type ListingOutcome<T> =
  | { readonly kind: 'loaded'; readonly value: T }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  /**
   * The category was reconfigured while the form was open (slice 2.4b).
   *
   * Its own kind rather than another `invalid`, because the two need opposite
   * things from the person reading them: `invalid` asks them to correct a field,
   * and this asks them to look again at fields that may have changed shape
   * underneath them. Collapsing it into `invalid` would produce "that is not a
   * field of this category" about a field they were shown.
   */
  | { readonly kind: 'stale-category'; readonly reason: string }
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
      ? `no response within ${String(LISTINGS_TIMEOUT_MS)}ms`
      : error.message;
  }
  return String(error);
}

function readError(raw: string): { issues?: readonly string[]; message?: string } {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) return {};
    const record = body as { issues?: unknown; message?: unknown };
    return {
      ...(Array.isArray(record.issues)
        ? { issues: record.issues as readonly string[] }
        : {}),
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
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
): Promise<ListingOutcome<T>> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      signal: AbortSignal.timeout(LISTINGS_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
      },
      // A listing somebody has just written must not be served from a cache
      // holding what it said before.
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
    const { issues } = readError(await response.text());
    return { kind: 'invalid', issues: issues ?? ['The request was rejected'] };
  }

  if (response.status === 409) {
    const { message } = readError(await response.text());
    return {
      kind: 'stale-category',
      reason: message ?? 'the category was changed while this page was open',
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

export function fetchCategoryOptions(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<readonly CategoryOption[]>> {
  return call(
    new URL(CATEGORY_OPTIONS_PATH, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    (raw) => parseCategoryOptions(raw).categories,
  );
}

export function createListing(
  apiBaseUrl: string,
  token: string | null,
  draft: ListingDraftInput,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<OwnerListing>> {
  return call(
    new URL(LISTINGS_PATH, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListing,
    { method: 'POST', body: draft },
  );
}

export function fetchListing(
  apiBaseUrl: string,
  token: string | null,
  id: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<OwnerListing>> {
  return call(
    new URL(listingPath(id), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListing,
  );
}
