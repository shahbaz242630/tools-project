import { widerRadius } from '@platform/contracts';
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
export function browseHref(postcode: string, radiusMiles: SearchRadiusMiles): string {
  return `${BROWSE_PATH}?postcode=${encodeURIComponent(postcode)}&radiusMiles=${String(radiusMiles)}`;
}

/**
 * The same search one radius wider, or null at the top of the ladder.
 *
 * **The empty state's whole behaviour**, read from the contract's ordered list
 * rather than written out again: "nothing within 5 miles" offers 10, 10 offers
 * 20, and 100 offers nothing at all. That last case is why this is a function —
 * the alternative is a control that silently re-runs the identical search.
 */
export function widerSearchHref(
  postcode: string,
  radiusMiles: SearchRadiusMiles,
): { readonly href: string; readonly miles: SearchRadiusMiles } | null {
  const wider = widerRadius(radiusMiles);
  if (wider === null) return null;

  return { href: browseHref(postcode, wider), miles: wider };
}
