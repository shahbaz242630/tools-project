import {
  FIRST_SEARCH_PAGE,
  listingSearchQueryString,
  nextSearchPage,
  previousSearchPage,
  widerRadius,
} from '@platform/contracts';
import type { ListingSearchQuery, SearchRadiusMiles } from '@platform/contracts';

/**
 * Where things live **in this application**, as distinct from where they live in
 * the API (slice 3.1b).
 *
 * **This module exists because the two were confused, once, immediately.** The
 * first search card linked to `publicListingPath(id)` — which is
 * `/public/listings/:id`, the API route — instead of `/hire/:id`, the page. It
 * compiled, it type-checked, and it produced a link to a JSON document. A test
 * caught it; nothing else would have, because both are strings and both are
 * about the same listing.
 *
 * So the rule is: **`@platform/contracts` names API routes, this file names
 * pages, and nothing in a component builds either by hand.** A component that
 * writes `/hire/${id}` inline is one that cannot be corrected in one place when
 * §8.17 replaces the id with a slug in slice 2.12 — which is a change already on
 * the plan.
 */

/** The search page. */
export const BROWSE_PATH = '/browse';

/**
 * Both sides of a person's bookings (slice 4.8b).
 *
 * **Not `BOOKINGS_ROUTE` from the contracts package**, which is the API's
 * `/bookings` — the pair this module's docblock exists about. They spell the
 * same string today and mean different things: one returns JSON scoped to the
 * renter, and this one renders a page with a section for each party. Either
 * could move without the other.
 */
export const BOOKINGS_PAGE_PATH = '/bookings';

/**
 * One booking, as either party reads it — where a renter pays (slice 5.2d).
 *
 * **Not `bookingPath` from the contracts package**, and this is the sharpest
 * instance of the collision this module exists about: the two functions take the
 * same argument, return the identical string today, and mean different things.
 * One addresses `GET /bookings/:bookingId` on the API; this one renders a page.
 * Importing the wrong one compiles, type-checks, and produces a link to a JSON
 * document — which is exactly what happened once with `publicListingPath`.
 */
export function bookingDetailPath(id: string): string {
  return `${BOOKINGS_PAGE_PATH}/${encodeURIComponent(id)}`;
}

/**
 * One listing, as a stranger reads it.
 *
 * **Not `publicListingPath` from the contracts package**, which is the API route
 * behind this page. See the module docblock — they differ by one word and one of
 * them renders.
 *
 * **The id will not always be in it.** §8.17 wants stable crawlable slugs and
 * slice 2.12 is where they arrive; the id stays inside whatever the slug becomes
 * so old links keep resolving, and this function is the one place that changes.
 */
export function hirePath(id: string): string {
  return `/hire/${encodeURIComponent(id)}`;
}

/**
 * One listing, as its **owner** reads it — the management page, not the public
 * one.
 *
 * **This is the twin of the confusion the module docblock describes, and it went
 * the other way.** `listingPath` from `@platform/contracts` is the *API* route
 * `GET /listings/:id`, and it was used as a page `href`, as a `redirect()` target
 * and as a `revalidatePath()` argument in seven places. All of them worked, and
 * every one of them worked by coincidence: the owner's page and the owner's API
 * resource happen to spell `/listings/:id` identically today. Nothing enforced
 * that, nothing tested it, and nothing would have failed the moment either
 * namespace moved.
 *
 * `revalidatePath` is the call that makes it more than pedantry — it takes a
 * *page* path and silently does nothing when handed one that matches no route,
 * so an API path there would mean an owner pressing Publish, the request
 * succeeding, and the page redrawing from cache still saying "Draft". That is
 * exactly the defect slice 2.8a fixed, waiting to come back through a rename
 * nobody would connect to it.
 *
 * **§8.17's slugs land in slice 2.12** and will change one of the two
 * namespaces. This function is the one place the page half changes.
 */
export function ownerListingPath(id: string): string {
  return `/listings/${encodeURIComponent(id)}`;
}

/**
 * The form that edits it.
 *
 * **A function rather than a suffix at the call site.** The listing page built
 * this as `` `${listingPath(id)}/edit` `` — string-concatenating an API path into
 * a page URL, which is the same mistake twice over and is invisible in review
 * because the result is right. Built from `ownerListingPath` so the two cannot
 * drift apart when 2.12 moves the id.
 */
export function editListingPath(id: string): string {
  return `${ownerListingPath(id)}/edit`;
}

/**
 * The owner's availability calendar (slice 4.3b).
 *
 * **Built from `ownerListingPath`, like the edit form above**, so 2.12 moving
 * the id out of the listing URL moves this with it. It is also the reason this
 * is not `` `${ownerListingPath(id)}/calendar` `` written at the call site: the
 * listing page links here, the calendar page links back, and a third place will
 * appear the moment the dashboard grows a column.
 *
 * **Not the API route.** `listingAvailabilityPath` in `@platform/contracts` is
 * `/listings/:id/availability` and returns JSON — the exact pair this module's
 * docblock exists about. A month is a query parameter on this page too, and the
 * page reads it; it is not part of the path.
 */
export function listingCalendarPath(id: string): string {
  return `${ownerListingPath(id)}/calendar`;
}

/**
 * A search, as a link.
 *
 * **It takes the whole search rather than a field per parameter** (slice 3.2a),
 * and that is a defect-prevention decision rather than tidiness. Four functions
 * in this file build a search URL, and a filter one of them forgets does not
 * fail: the searcher gets results from every category with nothing on screen or
 * in a log saying the narrowing was dropped. Passing `ListingSearchQuery` whole
 * means a new filter is a compile error in each of them — which is what has to
 * hold when price, rating and Phase 4's dates arrive behind category.
 *
 * **The query string itself comes from the contract** (`listingSearchQueryString`),
 * shared with the API's own path builder, so a page URL and an API URL cannot
 * disagree about how a search is spelled. It is also what keeps `?page=1` and
 * `?category=` from ever being minted — one search, one URL, which is half of
 * what slice 2.12 needs for §8.17's canonicals.
 */
export function browseHref(search: ListingSearchQuery): string {
  return `${BROWSE_PATH}?${listingSearchQueryString(search)}`;
}

/**
 * The same search, one page on — or null at the cap (slice 3.1d).
 *
 * **`widerSearchHref`'s shape, for its reason**: the boundary is decided in one
 * tested place rather than at the call site. A "Show more" control on the last
 * permitted page would link to a page the API refuses with a 400, which is BRD
 * §15's dead control wearing a working link's clothes.
 *
 * The caller supplies `hasMore` because only the server knows it — `truncated`
 * is measured by probing for one row beyond the page. This function answers the
 * other half: whether we are *allowed* to go there.
 */
export function nextSearchHref(
  search: ListingSearchQuery,
  hasMore: boolean,
): { readonly href: string; readonly page: number } | null {
  const next = nextSearchPage(search.page);
  if (!hasMore || next === null) return null;

  return { href: browseHref({ ...search, page: next }), page: next };
}

/** The same search, one page back — or null on the first. */
export function previousSearchHref(
  search: ListingSearchQuery,
): { readonly href: string; readonly page: number } | null {
  const previous = previousSearchPage(search.page);
  if (previous === null) return null;

  return { href: browseHref({ ...search, page: previous }), page: previous };
}

/**
 * The same search one radius wider, or null at the top of the ladder.
 *
 * **The empty state's whole behaviour**, read from the contract's ordered list
 * rather than written out again: "nothing within 5 miles" offers 10, 10 offers
 * 20, and 100 offers nothing at all. That last case is why this is a function —
 * the alternative is a control that silently re-runs the identical search.
 *
 * **It drops back to the first page**, and from slice 3.2a that is stated here
 * rather than inherited from a default argument: widening the radius changes
 * which listings exist and how they are ordered, so carrying page four across
 * would land somebody in the middle of a set they have never seen the start of.
 *
 * **The category is carried across**, which is the opposite treatment and the
 * right one — widening the radius is the answer to *"nothing near me"*, and
 * silently dropping the filter at the same time would answer a question the
 * searcher did not ask. Dropping the filter is its own offer, and it belongs to
 * the empty state rather than to this link.
 */
export function widerSearchHref(
  search: ListingSearchQuery,
): { readonly href: string; readonly miles: SearchRadiusMiles } | null {
  const wider = widerRadius(search.radiusMiles);
  if (wider === null) return null;

  return {
    href: browseHref({ ...search, radiusMiles: wider, page: FIRST_SEARCH_PAGE }),
    miles: wider,
  };
}
