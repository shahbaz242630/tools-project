/**
 * A listing's photographs, from the web app's side (slice 2.6c).
 *
 * **Its own file rather than four more functions in `listings.ts`**, which is
 * already 735 lines and answers a different question — the same argument
 * `media.ts` makes in the contracts package and `listing-media.service.ts`
 * makes in the API. What is *not* duplicated is the status mapping: every call
 * here goes through `call` from `listings.ts`, because a second mapping is the
 * H3a defect exactly — one client taught about a status and another not.
 *
 * **Two outcomes exist here that nothing else in the app can receive**, and both
 * are supplied through `call`'s hooks rather than added to the shared union:
 * a 422 refusal carrying a closed `reason`, and a 503 saying the object store
 * would not take the bytes.
 */

import {
  listingMediaItemPath,
  listingMediaOrderPath,
  listingMediaPath,
  parseOwnerListingMedia,
  parseOwnerListingMediaList,
} from '@platform/contracts';
import type { ListingMediaRefusal, OwnerListingMedia } from '@platform/contracts';
import { LISTING_MEDIA_REFUSALS } from '@platform/contracts';
import { call, messageIn } from './listings';
import type { FetchLike, ListingOutcome } from './listings';

/**
 * The store said no, and said why.
 *
 * **The reason is carried separately from the message**, because the two are
 * for different readers: the message is the API's sentence and reaches a person,
 * the reason is a closed union and reaches a counter. A page that only had the
 * message could not tell `too-many-photographs` — which is not the owner's
 * fault and needs a different sentence — from `not-an-image`, which is.
 */
export interface MediaRefused {
  readonly kind: 'refused';
  readonly reason: ListingMediaRefusal;
  readonly message: string;
}

/**
 * The object store would not take it (503).
 *
 * **Its own kind rather than `unreachable`**, for the reason `PublishOutcome`
 * gives about `unavailable`: this is not the API failing to answer, it is the
 * API answering that a dependency is down. Collapsing them would reduce an
 * explained, retryable refusal to *"API answered 503"* — and this one is
 * genuinely worth retrying in a moment, which `unreachable` gives no way to say.
 */
export interface MediaUnavailable {
  readonly kind: 'unavailable';
  readonly message: string;
}

export type MediaOutcome<T> = ListingOutcome<T> | MediaRefused | MediaUnavailable;

/**
 * A refusal reason, or nothing if the body did not carry a known one.
 *
 * **Validated against the union rather than cast into it.** The reason reaches a
 * `switch` that writes a sentence, and an unrecognised string arriving from a
 * newer API would fall through every case and render nothing at all — a silent
 * blank where a refusal belongs. Falling back to the API's own message instead
 * means an unknown reason degrades to a plain sentence rather than to absence.
 */
export function refusalIn(raw: string): ListingMediaRefusal | null {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) return null;
    const { reason } = body as { reason?: unknown };
    if (typeof reason !== 'string') return null;
    return LISTING_MEDIA_REFUSALS.find((known) => known === reason) ?? null;
  } catch {
    return null;
  }
}

/**
 * A 422 as an outcome.
 *
 * **`not-an-image` is the fallback rather than a new `unknown` member**, so the
 * union stays exactly the API's. It is reached only when a newer API sends a
 * reason this build has never heard of, and the message beside it is the API's
 * own — so the page shows the server's sentence rather than one written from a
 * guess about a value we do not recognise.
 */
function refused(raw: string): MediaRefused {
  return {
    kind: 'refused',
    reason: refusalIn(raw) ?? 'not-an-image',
    message: messageIn(raw) ?? 'That photograph was not accepted.',
  };
}

function unavailable(raw: string): MediaUnavailable {
  return {
    kind: 'unavailable',
    message:
      messageIn(raw) ??
      'Photographs cannot be stored right now. Nothing else about your listing ' +
        'is affected — try again in a few minutes.',
  };
}

export function fetchListingMedia(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<MediaOutcome<readonly OwnerListingMedia[]>> {
  return call(
    new URL(listingMediaPath(listingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    (raw) => parseOwnerListingMediaList(raw).media,
    { method: 'GET' },
    refused,
    unavailable,
  );
}

/**
 * Add one photograph.
 *
 * **The bytes go up as the body, not as a field of anything.** `call` labels
 * them `application/octet-stream`, which is the only content type the API's raw
 * parser is registered for — the multipart the browser sent was already unpacked
 * by the route handler in front, which is the only thing a browser can reach.
 */
export function uploadListingMedia(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  bytes: Uint8Array,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<MediaOutcome<OwnerListingMedia>> {
  return call(
    new URL(listingMediaPath(listingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerListingMedia,
    { method: 'POST', bytes },
    refused,
    unavailable,
  );
}

/**
 * Remove one photograph.
 *
 * The API answers 204, which `call` handles by parsing `null` — so the parser
 * here asserts the absence rather than ignoring it. A body arriving on a 204
 * would be a contract change this build should notice.
 */
export function deleteListingMedia(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  mediaId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<MediaOutcome<null>> {
  return call(
    new URL(listingMediaItemPath(listingId, mediaId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    () => null,
    { method: 'DELETE' },
    refused,
    unavailable,
  );
}

/**
 * Put them in a given order.
 *
 * **The whole list, because the contract takes the whole list** — a reorder
 * expressed as a move would have to be applied against the order the caller was
 * looking at, and two open tabs then produce an order neither person asked for.
 *
 * **Its 422 is not an upload refusal, and the page must not read it as one.**
 * The service reuses `not-an-image` for a stale order, so the `reason` here
 * describes nothing true; the message beside it ("the order must list exactly
 * this listing's photographs") does. Callers of this function show the message.
 */
export function reorderListingMedia(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  mediaIds: readonly string[],
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<MediaOutcome<readonly OwnerListingMedia[]>> {
  return call(
    new URL(listingMediaOrderPath(listingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    (raw) => parseOwnerListingMediaList(raw).media,
    { method: 'PUT', body: { mediaIds } },
    refused,
    unavailable,
  );
}
