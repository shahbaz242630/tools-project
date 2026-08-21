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

import {
  BOOKINGS_ROUTE,
  OWNER_BOOKINGS_ROUTE,
  bookingPath,
  bookingPayPath,
  parseBooking,
  parseBookingDetail,
  parseBookingPayment,
  parseBookingSummaries,
  parseOwnerBookings,
} from '@platform/contracts';
import type {
  Booking,
  BookingDetail,
  BookingPayment,
  BookingSummaries,
  OwnerBookings,
} from '@platform/contracts';
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

/**
 * The bookings a person is part of, both ways round (§14's *dashboards for both
 * parties*, slice 4.8b).
 *
 * **Two calls rather than one, because the API is two routes** — and it is two
 * routes because a role a caller names is a scope a caller chooses. The argument
 * is in `bookings.ts` in the contracts package; what matters here is that
 * nothing in this file passes a role, so nothing in this file can pass the wrong
 * one.
 *
 * **Both return the whole page rather than its rows**, `fetchOwnedListings`'
 * rule: `truncated` is something the reader has to be told, and handing back the
 * array alone drops it at the one boundary where the loss is invisible.
 */

/** What this person asked to hire. */
export function fetchMyBookings(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<BookingSummaries>> {
  return call(
    new URL(BOOKINGS_ROUTE, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseBookingSummaries,
  );
}

/** What is booked on this person's own listings. */
export function fetchBookingsOnMyListings(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<OwnerBookings>> {
  return call(
    new URL(OWNER_BOOKINGS_ROUTE, apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseOwnerBookings,
  );
}

/**
 * One booking, as the party looking at it reads it (slice 5.2d).
 *
 * **The first caller `GET /bookings/:bookingId` has ever had.** The route
 * shipped in 4.5a and its docblock carried a deletion deadline — *if Phase 5
 * closes without a caller, delete it* — because nothing rendered a single
 * booking; both dashboards read the collection routes. The pay page is what it
 * was kept for.
 *
 * **`not-found` covers "not yours" as well as "no such booking"**, and the API
 * refuses to say which. Both readings mean the same thing to the page, and
 * distinguishing them would confirm a booking id to somebody guessing.
 */
export function fetchBooking(
  apiBaseUrl: string,
  token: string | null,
  bookingId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ListingOutcome<BookingDetail>> {
  return call(
    new URL(bookingPath(bookingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseBookingDetail,
  );
}

/**
 * What paying can answer (slice 5.2d).
 *
 * **`refused` is the 422 and it carries the API's own words**, exactly as
 * `BookingRequestOutcome` does: 5.2c writes those sentences for the renter
 * reading them — *"That booking is already paid for. Nothing has been charged
 * again."* — and anything this layer added would be talking over the one place
 * that knows what happened.
 */
export type BookingPaymentOutcome =
  | ListingOutcome<BookingPayment>
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Pay for a booking the owner accepted (§8.7).
 *
 * **No body**, which is `bookingPayPath`'s decision restated where the request is
 * actually sent: what is owed was fixed when the booking was made (§8.2) and is
 * on its row, and a client that could send an amount could send the wrong one.
 *
 * **Nothing here derives an idempotency key.** Payments computes its own from the
 * booking and the count of failed attempts (5.2c), so a double press charges
 * once without this layer — or a browser — having to be trusted with it.
 */
export function payForBooking(
  apiBaseUrl: string,
  token: string | null,
  bookingId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<BookingPaymentOutcome> {
  return call(
    new URL(bookingPayPath(bookingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseBookingPayment,
    { method: 'POST' },
    (raw) => ({
      kind: 'refused' as const,
      reason: messageIn(raw) ?? 'that payment was not accepted',
    }),
  );
}
