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
  listingPublicationPath,
  parseCategoryOptions,
  parseOwnedListings,
  parseOwnerListing,
  parsePublicationRefusal,
} from '@platform/contracts';
import type {
  CategoryOption,
  ListingDraftInput,
  ListingEditInput,
  OwnedListings,
  OwnerListing,
  PublicationBlocker,
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

/**
 * Publishing can fail one way nothing else can (slice 2.8a).
 *
 * **Not a member of `ListingOutcome`**, deliberately. Only the publish route can
 * answer 422, so putting it in the shared union would make every caller of
 * `fetchListing` and `createListing` handle a case they can never receive — the
 * same objection this codebase makes to a status vocabulary carrying values
 * nothing produces. A reader of one of those switches would have no way to tell
 * whether the branch is unreachable or merely unimplemented.
 *
 * `invalid` is the neighbouring kind and means the opposite thing: that a
 * corrected request would work. Here the request is fine and the listing is not
 * ready, which is not something a different body could fix.
 */
export type PublishOutcome =
  | ListingOutcome<OwnerListing>
  | { readonly kind: 'not-ready'; readonly blockers: readonly PublicationBlocker[] }
  /**
   * The platform-wide switch is off (slice H3a, ADR 0036).
   *
   * **A third kind, not a variant of the two beside it**, because it answers a
   * different question again. `invalid` means "correct your request";
   * `not-ready` means "complete your listing"; this means "nothing is wrong
   * with either, and the platform is not accepting publications right now".
   * Folding it into `unreachable` — which is where it landed before this
   * existed — reduces a deliberate, explained refusal to `API answered 503`.
   */
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * What pausing can answer (slice 2.8b).
 *
 * **`refused` exists because 409 already meant something else here**, and that
 * is worth stating rather than leaving as a type. The shared `call` maps every
 * 409 to `stale-category` — correct for creating a listing, where a conflict
 * really does mean the category moved underneath the form — so a pause refused
 * for being a draft would have told the owner *"the category was changed while
 * this page was open"*: fluent, specific, and about something that did not
 * happen.
 *
 * That is the H3a defect exactly, one status along: **a status code reused on
 * the server is not handled until the client that reads it says which meaning it
 * has.** The 503 got its own hook for the same reason and this one follows it.
 */
export type PauseOutcome =
  ListingOutcome<OwnerListing> | { readonly kind: 'refused'; readonly reason: string };

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

async function call<T, E422 = never, E503 = never, E409 = never>(
  url: string,
  token: string | null,
  clientIp: string | null,
  fetchImpl: FetchLike,
  parse: (raw: unknown) => T,
  init: { method: string; body?: unknown } = { method: 'GET' },
  /**
   * What a 422 means, for the one route that can send one.
   *
   * A parameter rather than a branch in here, so that a status only publishing
   * can receive does not become a case every other caller has to handle.
   */
  on422?: (raw: string) => E422,
  /**
   * What a 503 means, for the one route that can send one.
   *
   * A parameter for `on422`'s reason, and the omission of it is what slice H3a
   * found by pressing the button: publish gained a 503, every other status was
   * already mapped, and this one fell through to the generic branch that prints
   * the number. **A status added on the server is not handled until the client
   * that reads it says so.**
   */
  on503?: (raw: string) => E503,
  /**
   * What a 409 means, for a route where it is not a stale category.
   *
   * The default below reads every 409 as "the configuration moved underneath
   * this form", which is right for creating a listing and wrong for pausing
   * one. Supplying this is how a caller says which conflict it is asking about;
   * omitting it keeps the behaviour every existing caller already relies on.
   */
  on409?: (raw: string) => E409,
): Promise<ListingOutcome<T> | E422 | E503 | E409> {
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

  if (response.status === 422 && on422 !== undefined) {
    return on422(await response.text());
  }

  if (response.status === 503 && on503 !== undefined) {
    return on503(await response.text());
  }

  if (response.status === 409) {
    const raw409 = await response.text();
    if (on409 !== undefined) return on409(raw409);

    const { message } = readError(raw409);
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

/**
 * Everything this owner has listed (slice 2.9a).
 *
 * **`GET` on the same path `createListing` posts to**, which is why there is no
 * new constant: one collection, two verbs. The projection differs — a summary
 * per row rather than the whole listing — and `parseOwnedListings` is what says
 * so on this side.
 *
 * The whole page is returned rather than only its rows, because `truncated` is
 * something the reader has to be told. Handing back the array alone would drop
 * it silently at the one boundary where the loss is invisible.
 */
export function fetchOwnedListings(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<OwnedListings>> {
  return call(
    new URL(LISTINGS_PATH, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnedListings,
  );
}

/**
 * Rewrite a listing (§8.3, slice 2.9b-i, ADR 0042).
 *
 * `PUT` on the listing's own path, with every field present — a partial is a
 * shape where "absent" and "clear this" are the same value on the wire.
 *
 * **The 409 keeps its default meaning here, unlike `pauseListing`.** On this
 * route a conflict really is a stale category: the form was built from the
 * current configuration and an administrator replaced it while it sat open,
 * which is exactly what `stale-category` says. That is a change from what an
 * edit would have meant before ADR 0042, when a listing revalidated against a
 * version a trigger refuses to update and so could not go stale at all.
 */
export function updateListing(
  apiBaseUrl: string,
  token: string | null,
  id: string,
  edit: ListingEditInput,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<OwnerListing>> {
  return call(
    new URL(listingPath(id), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListing,
    { method: 'PUT', body: edit },
  );
}

/**
 * Publish a listing (§8.3, slice 2.8a).
 *
 * `parseOwnerListing` on the way back, so a successful publish returns the
 * listing in its new state rather than a bare acknowledgement — the page that
 * called this re-renders from it, and a second read would be a chance for the
 * two to disagree.
 */
export function publishListing(
  apiBaseUrl: string,
  token: string | null,
  id: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<PublishOutcome> {
  return call(
    new URL(listingPublicationPath(id), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListing,
    { method: 'POST' },
    (raw) => ({ kind: 'not-ready', blockers: readBlockers(raw) }),
    (raw) => ({ kind: 'unavailable', reason: readUnavailableReason(raw) }),
  );
}

/**
 * Take a listing out of public view (§8.3, slice 2.8b).
 *
 * `DELETE` on the same path `publishListing` posts to, because pausing is
 * removing the publication rather than a separate thing done to a listing.
 *
 * **No `on503`.** The kill switch does not gate pausing — an owner must be able
 * to withdraw their item during exactly the incident that switch exists for — so
 * a 503 here would mean the API genuinely fell over, and the generic
 * `unreachable` branch is the honest answer to that. Passing a hook that
 * explained a deliberate refusal would invent one.
 */
export function pauseListing(
  apiBaseUrl: string,
  token: string | null,
  id: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<PauseOutcome> {
  return call(
    new URL(listingPublicationPath(id), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListing,
    { method: 'DELETE' },
    undefined,
    undefined,
    (raw) => ({ kind: 'refused', reason: readRefusalReason(raw) }),
  );
}

/**
 * The API's sentence out of a 409 body.
 *
 * `readUnavailableReason`'s shape and its reasoning: the API is the only thing
 * that knows which transition was refused and why, and a sentence maintained on
 * this side would drift from it. The fallback is a whole sentence rather than a
 * status code, because somebody who has just pressed Pause needs to know what
 * happened to their listing.
 */
function readRefusalReason(raw: string): string {
  const fallback =
    'This listing cannot be paused from its current state. Reload the page to ' +
    'see where it stands.';

  const { message } = readError(raw);
  return message !== undefined && message !== '' ? message : fallback;
}

/**
 * The API's own sentence out of a 503 body.
 *
 * Served verbatim rather than replaced with copy written here, because the API
 * is the only thing that knows *why* it refused, and a second sentence
 * maintained on this side would drift from it. The fallback is a full sentence
 * rather than a status code: somebody who has just pressed Publish needs to know
 * the platform refused, not that a number came back.
 */
function readUnavailableReason(raw: string): string {
  const fallback =
    'Publishing is temporarily switched off across the platform. ' +
    'Your listing is saved and unchanged — try again shortly.';

  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) return fallback;

    const { message } = body as { message?: unknown };
    return typeof message === 'string' && message !== '' ? message : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The blockers out of a 422 body.
 *
 * Falls back to one generic blocker rather than throwing, because the failure it
 * would be reporting is *"the API told us why and we could not read it"* — and a
 * page that crashes there is strictly worse than one saying "something is
 * missing" while the owner looks at the form. The API is the authority either
 * way; this list is what the interface points at.
 */
function readBlockers(raw: string): readonly PublicationBlocker[] {
  try {
    return parsePublicationRefusal(JSON.parse(raw)).blockers;
  } catch {
    return [
      {
        field: '',
        message: 'Something is still missing. Check the fields above and save again.',
      },
    ];
  }
}
