/**
 * Turning a quote into a request, from the web app's side (BRD §8.6, slice
 * 4.5b).
 *
 * **A quote id and nothing else crosses this wire**, which is `bookingRequest
 * Schema`'s decision and worth restating where the request is actually sent: the
 * dates, the postcode, the price and the pinned configuration version are all on
 * the quote already, and asking a client to restate facts the server holds
 * creates a disagreement somebody then has to resolve by trusting one of them.
 *
 * **So there is no way to book without a quote**, which is what guarantees the
 * money was shown to somebody before it was agreed — §3.4.4's whole point.
 *
 * The shim is `listings.ts`'s `call`, as everywhere else. See `quotes.ts` for
 * why that matters rather than being tidiness.
 */

import { BOOKINGS_ROUTE, parseBooking } from '@platform/contracts';
import type { Booking } from '@platform/contracts';
import { call, messageIn } from './listings';
import type { FetchLike, ListingOutcome } from './listings';

/**
 * What submitting a request can answer.
 *
 * **`refused` is the 422 and it is the interesting one**, because every member
 * of it describes something true that was not true when the quote was made
 * thirty minutes ago: the price expired, the owner withdrew the listing, or
 * somebody blocked or booked the dates in between. A quote outlives the facts it
 * was built on, which is why 4.5a re-checks all of them and why this cannot be
 * folded into `invalid` — the request was perfectly well formed and the world
 * moved.
 *
 * **`not-found` means the quote is not this person's, or does not exist**, and
 * the API refuses to say which. It is not a member worth a separate sentence on
 * the page: both readings are "start again", and distinguishing them would
 * confirm to somebody guessing quote ids that one of them exists.
 */
export type BookingRequestOutcome =
  ListingOutcome<Booking> | { readonly kind: 'refused'; readonly reason: string };

/** Submit the request (§8.6). Creates a booking in `REQUESTED`. */
export function requestBooking(
  apiBaseUrl: string,
  token: string | null,
  quoteId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<BookingRequestOutcome> {
  return call(
    new URL(BOOKINGS_ROUTE, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseBooking,
    { method: 'POST', body: { quoteId } },
    // Verbatim again. 4.5a writes these sentences for the renter reading them —
    // "That price has expired. Ask for the dates again…" tells somebody what to
    // do next, and anything this layer added would be talking over it.
    (raw) => ({
      kind: 'refused' as const,
      reason: messageIn(raw) ?? 'that request was not accepted',
    }),
  );
}
