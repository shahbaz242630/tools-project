import {
  FIRST_SEARCH_PAGE,
  nextSearchPage,
  previousSearchPage,
  widerRadius,
} from '@platform/contracts';
import type { SearchRadiusMiles } from '@platform/contracts';

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
 * A search, as a link.
 *
 * `encodeURIComponent` rather than `URLSearchParams` for the reason
 * `publicListingSearchPath` gives — and the parameter names are deliberately the
 * contract's, because this URL is parsed by the page using the contract's own
 * schema.
 */
export function browseHref(
  postcode: string,
  radiusMiles: SearchRadiusMiles,
  page: number = FIRST_SEARCH_PAGE,
): string {
  const query = `postcode=${encodeURIComponent(postcode)}&radiusMiles=${String(radiusMiles)}`;
  /*
   * **The first page carries no `page` parameter**, matching
   * `publicListingSearchPath` — one search, one URL. It is what keeps every link
   * written before slice 3.1d byte-identical, and it is half of the answer slice
   * 2.12 needs for §8.17's canonical URLs.
   */
  return `${BROWSE_PATH}?${page === FIRST_SEARCH_PAGE ? query : `${query}&page=${String(page)}`}`;
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
  postcode: string,
  radiusMiles: SearchRadiusMiles,
  page: number,
  hasMore: boolean,
): { readonly href: string; readonly page: number } | null {
  const next = nextSearchPage(page);
  if (!hasMore || next === null) return null;

  return { href: browseHref(postcode, radiusMiles, next), page: next };
}

/** The same search, one page back — or null on the first. */
export function previousSearchHref(
  postcode: string,
  radiusMiles: SearchRadiusMiles,
  page: number,
): { readonly href: string; readonly page: number } | null {
  const previous = previousSearchPage(page);
  if (previous === null) return null;

  return { href: browseHref(postcode, radiusMiles, previous), page: previous };
}

/**
 * The same search one radius wider, or null at the top of the ladder.
 *
 * **The empty state's whole behaviour**, read from the contract's ordered list
 * rather than written out again: "nothing within 5 miles" offers 10, 10 offers
 * 20, and 100 offers nothing at all. That last case is why this is a function —
 * the alternative is a control that silently re-runs the identical search.
 *
 * **It drops back to the first page**, which falls out of `browseHref`'s default
 * rather than being decided here — widening the radius changes which listings
 * exist and how they are ordered, so carrying page four across would land
 * somebody in the middle of a set they have never seen the start of.
 */
export function widerSearchHref(
  postcode: string,
  radiusMiles: SearchRadiusMiles,
): { readonly href: string; readonly miles: SearchRadiusMiles } | null {
  const wider = widerRadius(radiusMiles);
  if (wider === null) return null;

  return { href: browseHref(postcode, wider), miles: wider };
}
