/**
 * The requests waiting on an owner, and answering them (BRD §8.6, §7.1, slice
 * 4.6b).
 *
 * **Every date crossing this file is a `YYYY-MM-DD` string and never a `Date`** —
 * 4.3b's rule. The two exceptions on these projections are `requestExpiresAt`
 * here and on the booking, and both are moments we chose rather than days
 * somebody typed, so whatever renders them must state a timezone.
 *
 * **The HTTP shim is `listings.ts`'s `call`**, imported rather than copied, for
 * the reason 4.3b gave when it exported the thing: two status maps is how H3a's
 * defect happened.
 */

import {
  bookingAcceptPath,
  bookingDeclinePath,
  listingRequestsPath,
  parseBooking,
  parseListingRequests,
} from '@platform/contracts';
import type { Booking, ListingRequests } from '@platform/contracts';
import { call, messageIn } from './listings';
import type { FetchLike, ListingOutcome } from './listings';

/**
 * What answering a request can say.
 *
 * **Two kinds beyond the shared vocabulary, because the API sends two statuses
 * that mean different things and a caller must be able to act on the
 * difference** — the H3a lesson, twice over:
 *
 * - **`refused` is the 422**: the request is no longer waiting, it expired, or
 *   the owner's own calendar now blocks the dates. All three are things the
 *   owner can do something about, and none is fixed by correcting a field.
 * - **`taken` is the 409**, and it is emphatically not the same: somebody else's
 *   acceptance holds the period, nothing the owner changes fixes it, and it is
 *   not their mistake. Folding it into `refused` would tell them to try again at
 *   the one thing that cannot work.
 */
export type DecisionOutcome =
  | ListingOutcome<Booking>
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'taken'; readonly reason: string };

/** What is waiting on this owner for this listing. */
export function fetchRequests(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<ListingRequests>> {
  return call(
    new URL(listingRequestsPath(listingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseListingRequests,
  );
}

/** Accept it — which locks the dates and declines every conflict (§7.1). */
export function acceptRequest(
  apiBaseUrl: string,
  token: string | null,
  bookingId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<DecisionOutcome> {
  return decide(apiBaseUrl, token, bookingAcceptPath(bookingId), fetchImpl, clientIp);
}

/** Decline it. Locks nothing, so it cannot lose a race. */
export function declineRequest(
  apiBaseUrl: string,
  token: string | null,
  bookingId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<DecisionOutcome> {
  return decide(apiBaseUrl, token, bookingDeclinePath(bookingId), fetchImpl, clientIp);
}

/**
 * One request to one of the two decision routes.
 *
 * **Shared because the two answer in the same vocabulary**, and a second copy is
 * how a status added to one stops being handled on the other. The decline route
 * cannot in practice send a 409 — it locks nothing — and is still mapped, because
 * a hook that is right and unreachable costs nothing while a missing one costs a
 * page that prints a number at somebody.
 */
function decide(
  apiBaseUrl: string,
  token: string | null,
  path: string,
  fetchImpl: FetchLike,
  clientIp: string | null,
): Promise<DecisionOutcome> {
  return call(
    new URL(path, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseBooking,
    { method: 'POST' },
    // The API's own sentence, carried through unaltered — written for the person
    // who pressed the button, and this layer has nothing to add.
    (raw) => ({
      kind: 'refused' as const,
      reason: messageIn(raw) ?? 'that request could not be answered',
    }),
    undefined,
    (raw) => ({
      kind: 'taken' as const,
      reason:
        messageIn(raw) ??
        'those dates have just been taken by another booking, so this request can ' +
          'no longer be accepted',
    }),
  );
}
