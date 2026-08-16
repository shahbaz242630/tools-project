/**
 * The owner's calendar, from the web app's side (slice 4.3b).
 *
 * **Every date crossing this file is a `YYYY-MM-DD` string and never a `Date`.**
 * The API converts to instants in the platform's timezone and back again; a
 * `new Date(…)` anywhere in this app would redo that conversion in whatever
 * timezone the machine rendering the page happens to be in, which is a server in
 * Falkenstein today and a browser anywhere at all tomorrow.
 *
 * **The HTTP shim is `listings.ts`'s `call`**, imported rather than copied. Two
 * status maps is how H3a's defect happened: a status the server started sending
 * was handled in one client and printed as a number by the other.
 */

import {
  listingAvailabilityBlockPath,
  listingAvailabilityPath,
  parseAvailabilityBlock,
  parseListingAvailability,
} from '@platform/contracts';
import type {
  AvailabilityBlock,
  AvailabilityBlockRequest,
  ListingAvailability,
} from '@platform/contracts';
import { call } from './listings';
import type { FetchLike, ListingOutcome } from './listings';

/**
 * What blocking a period can answer.
 *
 * **`refused` is the 422**, and it is its own kind for the reason `PauseOutcome`
 * gives about 409: a status means what the route sending it says it means, and
 * the shared mapping has no idea. Here it is a period we will not accept —
 * already over, too far away, or too long — which no correction to the *shape*
 * of the request would fix, so it must not arrive as `invalid` and put a field
 * error under a date that is perfectly well formed.
 */
export type BlockOutcome =
  | ListingOutcome<AvailabilityBlock>
  | { readonly kind: 'refused'; readonly reason: string };

/** A month of the calendar. */
export function fetchAvailability(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  month: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<ListingAvailability>> {
  const path = listingAvailabilityPath(listingId);

  return call(
    new URL(
      // Absent rather than empty when no month is chosen. `?month=` would be a
      // value the API has to decide the meaning of, and the meaning it would
      // have to choose is the one an absent parameter already has.
      month === null ? path : `${path}?month=${encodeURIComponent(month)}`,
      apiBaseUrl,
    ).toString(),
    token,
    clientIp,
    fetchImpl,
    parseListingAvailability,
  );
}

/** Declare a period unavailable. */
export function blockPeriod(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  period: AvailabilityBlockRequest,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<BlockOutcome> {
  return call(
    new URL(listingAvailabilityPath(listingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseAvailabilityBlock,
    { method: 'POST', body: period },
    // The API's own sentence, carried through unaltered — it is written for the
    // person reading it and this layer has nothing to add.
    (raw) => ({
      kind: 'refused' as const,
      reason: messageIn(raw) ?? 'those dates were not accepted',
    }),
  );
}

/**
 * Remove a period.
 *
 * **204 with no body, so there is nothing to parse** — and `call` would try. It
 * is given a parser that ignores what it is handed and returns nothing, which is
 * honest about a route whose success has no representation.
 */
export function unblockPeriod(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  blockId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<null>> {
  return call(
    new URL(listingAvailabilityBlockPath(listingId, blockId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    () => null,
    { method: 'DELETE' },
  );
}

/** The `message` out of an error body, or nothing if it is not one. */
function messageIn(raw: string): string | null {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) return null;
    const { message } = body as { message?: unknown };
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}
