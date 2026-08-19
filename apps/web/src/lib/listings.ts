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
  CATEGORY_OPTIONS_ROUTE,
  CLIENT_IP_HEADER,
  LISTINGS_ROUTE,
  PUBLIC_CATEGORIES_ROUTE,
  listingPath,
  listingPublicationPath,
  parseCategoryOptions,
  parseOwnedListings,
  parseOwnerListing,
  parsePublicCategories,
  parsePublicListing,
  parsePublicListingSearchResults,
  parsePublicationRefusal,
  publicListingPath,
  publicListingSearchPath,
} from '@platform/contracts';
import type {
  CategoryOption,
  ListingDraftInput,
  ListingEditInput,
  ListingSearchQuery,
  OwnedListings,
  OwnerListing,
  PublicCategory,
  PublicListing,
  PublicListingSearchResults,
  PublicationBlocker,
} from '@platform/contracts';
import { correlationHeaders } from './correlation';

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

/**
 * What editing can answer (slice 2.9b-ii).
 *
 * **A second 422 in this file, and it is not `not-ready`.** Both carry the same
 * `blockers`, because both are the completeness rules — but they are opposite
 * situations and a form that showed the publish wording here would be actively
 * misleading. `not-ready` is *"finish this and it can go live"*, said to somebody
 * who asked to publish. This is *"it is live, and what you just saved would break
 * it"*, said to somebody who was correcting a typo and emptied a field on the way
 * past.
 *
 * `PublishOutcome` is deliberately not reused despite the identical payload. Two
 * routes answering 422 for two reasons is the H3a lesson one status along: **a
 * status code reused on the server is not handled until the client says which
 * meaning it has.**
 */
export type EditOutcome =
  | ListingOutcome<OwnerListing>
  | { readonly kind: 'incomplete'; readonly blockers: readonly PublicationBlocker[] };

/**
 * What the public listing read can answer (slice 2.10).
 *
 * **Three kinds where the guarded reads have seven**, and the four that are
 * missing are missing because they cannot happen. There is no session, so
 * `signed-out` and `forbidden` are meaningless; there is no request body, so
 * `invalid` is; there is no category being pinned, so `stale-category` is. A
 * union carrying cases nothing produces is one whose reader cannot tell an
 * unreachable branch from an unimplemented one — the same objection this file
 * already makes to `PublishOutcome` living in the shared type.
 *
 * `not-found` is the interesting one: it is what a draft, a paused listing, a
 * rejected listing and a nonexistent id all come back as, because the API
 * refuses to distinguish them (§8.4.1 reasoning applied to existence rather than
 * to location). The page renders Next's 404 for it and says nothing more.
 */
export type PublicOutcome<T> =
  | { readonly kind: 'loaded'; readonly value: T }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export type PublicListingOutcome = PublicOutcome<PublicListing>;

/**
 * A page of search results, or why there is not one (slice 3.1b).
 *
 * **`not-found` is unreachable on this one and that is deliberate**, rather than
 * a narrower type. The search route answers 200 with an empty list for every
 * "nothing here" — an unknown postcode, a provider outage, a genuinely empty
 * radius — so 404 never arrives. Sharing `PublicOutcome` keeps one shape for
 * every unauthenticated read; the page simply never reaches that branch, and
 * says so where it handles the others.
 */
export type ListingSearchOutcome = PublicOutcome<PublicListingSearchResults>;

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

/**
 * One request to a guarded API route, as an outcome rather than an exception.
 *
 * **Exported from slice 4.3b, for the availability client next door.** It was
 * private while this file was the only caller, and the alternative — a second
 * copy of the status mapping in `availability.ts` — is the shape this codebase
 * has been bitten by twice: H3a found a 503 that fell through to *"API answered
 * 503"* because one client had been taught about it and the code path another
 * used had not. One mapping, one place, and a route that needs a status to mean
 * something particular says so with the hooks below.
 *
 * The calendar is the owner's view of their own listing, so it shares the
 * outcome vocabulary deliberately: `signed-out`, `forbidden` and `not-found`
 * mean exactly what they mean here. `stale-category` is the one member it can
 * never receive, and its page says so where it handles the rest.
 */
export async function call<T, E422 = never, E503 = never, E409 = never>(
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
        ...(await correlationHeaders()),
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

  /*
   * **204 has no body, by definition** (slice 4.3b, for the calendar's delete).
   *
   * Without this the success path below reads an empty string and hands it to
   * `JSON.parse`, which throws — so a route that worked perfectly would come
   * back as `malformed` and the page would report a failure for something it
   * had just done. The parser is still called, with `null`, so a caller that
   * genuinely expects content on a 204 finds out rather than receiving one.
   */
  if (response.status === 204) {
    try {
      return { kind: 'loaded', value: parse(null) };
    } catch (error) {
      return { kind: 'malformed', reason: describe(error) };
    }
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

/**
 * The `message` out of an error body, or nothing if it is not one.
 *
 * **Exported from slice 4.5b, and it is the same argument that exported `call`
 * one slice earlier.** Every client that translates a status for itself — the
 * calendar's 422, the quote's, the booking request's — needs to read the
 * sentence out of the body, and each one writing its own `JSON.parse` in a
 * `try` is three places for a body shape to be read three ways. It delegates to
 * `readError` rather than parsing again, so there is one reader of an error
 * body in this file and not two.
 */
export function messageIn(raw: string): string | null {
  return readError(raw).message ?? null;
}

export function fetchCategoryOptions(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<readonly CategoryOption[]>> {
  return call(
    new URL(CATEGORY_OPTIONS_ROUTE, apiBaseUrl).toString(),
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
    new URL(LISTINGS_ROUTE, apiBaseUrl).toString(),
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
 * One listing, as anybody may see it (slice 2.10).
 *
 * **It does not go through `call`, and the reason is the first line of that
 * function**: `if (token === null) return { kind: 'signed-out' }`. That guard is
 * correct for every other read here and is exactly wrong for this one — a
 * signed-out visitor is the *expected* caller, and routing this through `call`
 * would mean the public page rendered "your session has expired" to the public.
 *
 * Adding a "public" flag to `call` was the alternative and it is the worse one:
 * a boolean that switches off an authentication check is a boolean somebody
 * passes wrongly, and the failure would be silent in the safe-looking direction
 * only until it wasn't. A separate function cannot be called with a token by
 * accident, because it takes none.
 *
 * **No `x-client-ip` either.** ADR 0017 forwards it so the audit log can record
 * who did something; nothing here is audited, nobody is identified, and sending
 * a visitor's IP inward for a read that records nothing would be collecting it
 * for no purpose — which is the data-minimisation principle §10 states.
 */
export function fetchPublicListing(
  apiBaseUrl: string,
  id: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<PublicListingOutcome> {
  return publicCall(
    new URL(publicListingPath(id), apiBaseUrl).toString(),
    fetchImpl,
    parsePublicListing,
  );
}

/**
 * Listings near a postcode (slice 3.1b).
 *
 * **The unauthenticated sibling of `fetchOwnedListings`**, and it carries no
 * token and no `x-client-ip` for the reason `fetchPublicListing` gives: nobody
 * is identified, nothing is audited, and forwarding a visitor's IP for a read
 * that records nothing would be collecting it for no purpose (§10).
 *
 * **The path is built by the contract**, so the query string this sends and the
 * one the API parses are assembled by the same function. A page hand-writing
 * `?postcode=…&radius=…` is a page that can disagree with the server about a
 * parameter name and get an empty result instead of an error.
 *
 * **It takes the parsed query whole** (slice 3.2a), which is both narrower and
 * safer than the four arguments it replaced: every field has already been
 * through the contract's schema, so a radius the BRD does not name and a
 * malformed category slug cannot reach it — and there is no argument order for
 * a caller to get wrong now that two of the fields are strings. The API
 * validates the lot again regardless; that is the control, this is the courtesy.
 */
/**
 * The categories a searcher can narrow to (slice 3.2b).
 *
 * **Unauthenticated, like the search beside it** — Browse is the page a
 * signed-out stranger meets first, so a filter that needed a token would be a
 * control that works only once you have an account.
 *
 * **The caller must treat a failure as "no filter", never as a broken page.**
 * That is stated here because it is the whole risk of adding this read to
 * Browse: search does not depend on the category list, and a page that refused
 * to render a search because a `select` could not be populated would turn a
 * cosmetic outage into a total one. `/browse` renders without the control.
 */
export function fetchPublicCategories(
  apiBaseUrl: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<PublicOutcome<readonly PublicCategory[]>> {
  return publicCall(
    new URL(PUBLIC_CATEGORIES_ROUTE, apiBaseUrl).toString(),
    fetchImpl,
    (raw) => parsePublicCategories(raw).categories,
  );
}

export function fetchListingSearch(
  apiBaseUrl: string,
  search: ListingSearchQuery,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<ListingSearchOutcome> {
  return publicCall(
    new URL(publicListingSearchPath(search), apiBaseUrl).toString(),
    fetchImpl,
    parsePublicListingSearchResults,
  );
}

/**
 * The unauthenticated read, with the four outcomes it can actually have.
 *
 * A sibling of `call` rather than a parameterisation of it — see
 * `fetchPublicListing`. It is short because it has nothing to do: no token, no
 * body, no 409, no 422, no 503.
 */
async function publicCall<T>(
  url: string,
  fetchImpl: FetchLike,
  parse: (raw: unknown) => T,
): Promise<PublicOutcome<T>> {
  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(LISTINGS_TIMEOUT_MS),
      // No credentials — that is the point of this path — but still the trace.
      // A stranger's search is exactly the request nobody can reproduce later.
      headers: { ...(await correlationHeaders()) },
      // **`no-store`, on a page that is otherwise ideal to cache.** A listing
      // paused or rejected a moment ago must stop being served, and a cached
      // copy is a listing the platform has taken down and is still showing.
      // Caching this is a real optimisation and it belongs with a real
      // invalidation story, which is Phase 3's or 2.12's rather than a default
      // inherited by accident.
      cache: 'no-store',
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  // Draft, paused, rejected, or no such listing — all one answer, because the
  // API refuses to tell them apart.
  if (response.status === 404) return { kind: 'not-found' };

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
    // **Refused rather than rendered.** The projection is what keeps a street
    // address off this page, so a response that does not match it is one this
    // build cannot vouch for — and rendering it anyway is how a field nobody
    // reviewed reaches the internet.
    return { kind: 'malformed', reason: describe(error) };
  }
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
    new URL(LISTINGS_ROUTE, apiBaseUrl).toString(),
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
): Promise<EditOutcome> {
  return call(
    new URL(listingPath(id), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListing,
    { method: 'PUT', body: edit },
    // The 422 hook, reading the same `blockers` array publishing does — the API
    // answers both with one shape precisely so this parser is not written twice
    // (slice 2.9b-ii).
    (raw) => ({ kind: 'incomplete', blockers: readBlockers(raw) }),
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
