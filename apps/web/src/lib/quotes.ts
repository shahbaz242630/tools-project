/**
 * Asking a listing what a period costs, from the web app's side (BRD §8.5.2,
 * slice 4.5b).
 *
 * **Every date crossing this file is a `YYYY-MM-DD` string and never a `Date`** —
 * 4.3b's rule, and the reason is unchanged: the API turns a chosen day into an
 * instant in the platform's timezone, and a `new Date(…)` here would redo that
 * conversion in whatever zone the machine rendering the page happens to be in.
 * That is a server in Falkenstein today and a browser anywhere at all tomorrow.
 *
 * **The HTTP shim is `listings.ts`'s `call`**, imported rather than copied, for
 * the reason 4.3b gave when it exported the thing: two status maps is how H3a's
 * defect happened, where a status the server had started sending was handled in
 * one client and printed as a number by the other.
 *
 * **There is no `fetchQuote` here, deliberately.** The quote route can be read
 * back and nothing in this app reads it — the panel holds the quote it just
 * created in its action state. A function with no caller is a function nobody
 * has checked, and the API's own controller makes the same argument about the
 * collection route it declined to build.
 */

import { listingQuotesPath, parseRentalQuote } from '@platform/contracts';
import type { QuoteRequest, RentalQuote } from '@platform/contracts';
import { call, messageIn } from './listings';
import type { FetchLike, ListingOutcome } from './listings';

/**
 * What asking for a price can answer.
 *
 * **`refused` is the 422**, and it is its own kind for the reason `BlockOutcome`
 * gives next door: a status means what the route sending it says it means, and
 * the shared mapping has no idea which. Here it is a period, a price or a
 * listing we will not quote — already over, longer than the category's cap,
 * below the minimum booking total, or the caller's own item — and **no
 * correction to the *shape* of the request would fix any of them**. Arriving as
 * `invalid` would put a field error under a date that is perfectly well formed.
 *
 * **`not-found` covers four facts at once** and must not be unpicked here: no
 * such listing, not published, hidden by the platform, or an owner who has not
 * declared themselves a private individual. The API returns one null for all
 * four precisely so a stranger cannot tell them apart.
 */
export type QuoteOutcome =
  ListingOutcome<RentalQuote> | { readonly kind: 'refused'; readonly reason: string };

/** Price a period, and persist the price (§8.5.2 — a quote is a record). */
export function requestQuote(
  apiBaseUrl: string,
  token: string | null,
  listingId: string,
  period: QuoteRequest,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<QuoteOutcome> {
  return call(
    new URL(listingQuotesPath(listingId), apiBaseUrl).toString(),
    token,
    clientIp,
    fetchImpl,
    parseRentalQuote,
    { method: 'POST', body: period },
    // The API's own sentence, carried through unaltered — it is written for the
    // person who chose the dates and this layer has nothing to add to it.
    (raw) => ({
      kind: 'refused' as const,
      reason: messageIn(raw) ?? 'that period could not be priced',
    }),
  );
}
