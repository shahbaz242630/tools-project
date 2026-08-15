import { z } from 'zod';
import { coarseLocationSchema, postcodeSchema } from './address.js';
import type { CoarseLocation } from './address.js';
import {
  CATEGORY_SLUG_PATTERN,
  MAX_CATEGORY_SLUG_LENGTH,
  MIN_CATEGORY_SLUG_LENGTH,
} from './catalogue.js';
import { inclusiveDailyPriceSchema } from './pricing.js';
import type { InclusiveDailyPrice } from './pricing.js';
import { ownerStatusSchema } from './profiles.js';
import type { OwnerStatus } from './profiles.js';
import { parseWith } from './parse.js';

/**
 * Finding a listing near somewhere (BRD §8.4, §8.4.1, slice 3.1a).
 *
 * **Its own contract file, because search is its own module.** Everything here
 * describes what Search & Location answers, and keeping it beside `listings.ts`
 * rather than inside it is the same instinct that gave the module its own
 * directory: the two shapes look alike and are owned by different rules.
 */

/**
 * The radii a searcher may choose, in miles — **BRD §8.4's list, not a range.**
 *
 * A closed vocabulary rather than a number, and that is a privacy control rather
 * than a UI simplification. An arbitrary radius is an attacker's binary search:
 * ask for 1 mile, then 2, then 3, and the radius at which a listing first
 * appears is its distance from that origin to whatever precision the control
 * allows. Five fixed steps make each probe cheap to reason about and coarse
 * enough to be useless — and ADR 0032 removes the rest of the attack by
 * measuring from the fuzzed point, so what a determined prober converges on is a
 * position we publish on purpose.
 *
 * **Ascending, and the order is load-bearing**: the empty state offers the next
 * radius up, so the ladder is read from this array rather than written out again
 * in the page.
 */
export const SEARCH_RADII_MILES = [5, 10, 20, 50, 100] as const;
export type SearchRadiusMiles = (typeof SEARCH_RADII_MILES)[number];

/**
 * What a searcher gets if they do not choose — the smallest.
 *
 * The narrowest default is the right one for a hyperlocal marketplace: a renter
 * who wanted a wider net can widen it in one click, and the empty state exists
 * to offer exactly that. Starting wide would bury a lawnmower two streets away
 * under one forty miles off.
 */
export const DEFAULT_SEARCH_RADIUS_MILES: SearchRadiusMiles = 5;

/** The next radius up, or null at the top of the ladder. */
export function widerRadius(radius: SearchRadiusMiles): SearchRadiusMiles | null {
  const next = SEARCH_RADII_MILES[SEARCH_RADII_MILES.indexOf(radius) + 1];
  return next ?? null;
}

/*
 * **The coercion carries its own message, and that is a copy fix rather than a
 * validation one** (found by looking, slice 3.1d). `z.coerce.number()` rejects
 * `?radiusMiles=abc` with *"Invalid input: expected number, received NaN"*, and
 * the Browse page renders that message to a person as **"Radius Invalid input:
 * expected number, received NaN."** — a stack trace wearing a sentence's
 * clothes. The refusal was correct; only the words were wrong, which is why no
 * test caught it and reading the page did.
 *
 * Both failure modes now say the same thing, because for a closed vocabulary
 * they are the same thing: what you typed is not one of the five.
 */
export const searchRadiusMilesSchema = z.coerce
  .number(`must be one of ${SEARCH_RADII_MILES.join(', ')}`)
  .refine(
    (value): value is SearchRadiusMiles =>
      (SEARCH_RADII_MILES as readonly number[]).includes(value),
    `must be one of ${SEARCH_RADII_MILES.join(', ')}`,
  );

/**
 * How many results one page carries (slice 3.1a, paginated in 3.1d).
 *
 * **It lives in the contract because both sides need the same number**, and they
 * need it for different halves of the same sentence: the API skips this many
 * rows per page, and the page renders *"Tools 25–48 near you"*. Two constants
 * that must agree only agree by accident — the argument `Paging.probe` makes
 * about itself — and here the disagreement would be silent, showing somebody a
 * range that does not describe what is under it.
 *
 * `catalogue/limits.ts` still owns the *decision* to bound this read at all
 * (ADR 0035) and re-exports this value as `SEARCH_RESULT_LIMIT`. What moved here
 * is the number, not the reasoning.
 *
 * Twenty-four rather than twenty because it divides by two, three and four, so a
 * grid has no ragged last row at any of the breakpoints the design uses.
 */
export const SEARCH_PAGE_SIZE = 24;

/** The page a searcher gets if they do not ask for one. */
export const FIRST_SEARCH_PAGE = 1;

/**
 * How deep anybody may page — **a denial-of-service bound, not a product one**
 * (slice 3.1d).
 *
 * Offset pagination skips rows the database has already found, so `page=100000`
 * is a two-and-a-half-million-row skip on **the most exposed endpoint in the
 * system**: a collection, from an origin the caller chooses, with no rate
 * limiting anywhere in front of it (`SECURITY.md`). The cap is what stops one
 * query string costing more than the whole search.
 *
 * Twenty pages is 480 results, which is past any depth a person browsing tools
 * near them will reach — and somebody who genuinely needs to see more of a
 * dense area wants a narrower radius or the filters that are still to come,
 * not page 40. **A page beyond it is refused rather than clamped**, exactly as
 * a radius of 7 is: a URL claiming something we do not serve should be told so
 * rather than quietly answered with something else.
 */
export const MAX_SEARCH_PAGE = 20;

/**
 * Which page of results, one-based.
 *
 * **A page number rather than an offset**, and that is the security half of
 * slice 3.1d's decision. The server multiplies by its own page size, so a caller
 * cannot ask to skip an arbitrary number of rows and cannot read the page size
 * out of the URL. It is also the shape §8.17's canonical URLs will need in slice
 * 2.12, and the shape a person can read.
 *
 * **Not a cursor**, which is the option this replaced — see ADR 0045. A keyset
 * cursor over a distance-ordered search carries an exact distance, and a URL is
 * copied into browser history, referrer headers, access logs and shared links.
 */
export const searchPageSchema = z.coerce
  // Same message as `.int` below, so "two" and "1.5" read alike — see the note
  // on `searchRadiusMilesSchema` for why the default one cannot be shown.
  .number('must be a whole number')
  .int('must be a whole number')
  .min(FIRST_SEARCH_PAGE, `must be ${String(FIRST_SEARCH_PAGE)} or more`)
  .max(MAX_SEARCH_PAGE, `must be ${String(MAX_SEARCH_PAGE)} or less`);

/**
 * How many results come before this page — **the offset, and the heading**.
 *
 * One function with two readers, which is the point of it. The API skips this
 * many rows; the results heading says *"Tools 25–48 near you"* from the same
 * number plus one. Written out separately they would be two expressions that
 * have to agree, and the failure would be silent: a heading that mislabels
 * which results are underneath it looks exactly like a correct one.
 */
export function resultsToSkip(page: number): number {
  return (page - FIRST_SEARCH_PAGE) * SEARCH_PAGE_SIZE;
}

/**
 * The next page, or null at the cap — `widerRadius`'s shape, for its reason.
 *
 * A function rather than `page + 1` at the call site so that the boundary is
 * decided in one place. The alternative is a "Show more" control on page 20
 * that links to a page the API refuses.
 */
export function nextSearchPage(page: number): number | null {
  return page >= MAX_SEARCH_PAGE ? null : page + 1;
}

/** The previous page, or null on the first. */
export function previousSearchPage(page: number): number | null {
  return page <= FIRST_SEARCH_PAGE ? null : page - 1;
}

/**
 * Narrowing a search to one category — **BRD §8.4's second filter** (slice
 * 3.2a).
 *
 * **A slug rather than an id**, for the reason `Category.slug` exists at all: it
 * is the category's stable public identity, it is what §8.17's landing pages
 * will be built on, and it survives a rename where a display name does not. The
 * id is resolved on the server and never appears in a URL.
 *
 * **`null` means every category, and it is a real value rather than an absent
 * one.** Three inputs all arrive here meaning the same thing and all must be
 * accepted: the parameter missing entirely (a link written before this slice),
 * `?category=` empty (**what a plain GET form submits when "All categories" is
 * chosen** — the case that would otherwise 400 the ordinary path), and
 * whitespace. Only a *malformed* slug is refused.
 *
 * **The message is the searcher's, not the administrator's**, which is slice
 * 3.1d's lesson applied before it could bite: `categorySlugSchema` says
 * *"must be lowercase letters, digits and single hyphens"*, which is a rule for
 * somebody typing into a configuration form. A searcher never typed this — it
 * came from a `select` or a pasted URL — so the only useful thing to tell them
 * is that it names nothing we have. **The pattern is shared and only the wording
 * differs** (`CATEGORY_SLUG_PATTERN`), so the two cannot disagree about what a
 * slug is.
 *
 * **A well-formed slug naming no category says the same sentence**, and is
 * refused by the service rather than here — this schema cannot know what exists
 * without a database. Both are one message on purpose: for a searcher,
 * "malformed" and "unknown" are the same fact.
 */
export const SEARCH_CATEGORY_MESSAGE = 'is not a category we have';

export const searchCategorySchema = z
  .preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string(SEARCH_CATEGORY_MESSAGE)
      .min(MIN_CATEGORY_SLUG_LENGTH, SEARCH_CATEGORY_MESSAGE)
      .max(MAX_CATEGORY_SLUG_LENGTH, SEARCH_CATEGORY_MESSAGE)
      .regex(CATEGORY_SLUG_PATTERN, SEARCH_CATEGORY_MESSAGE)
      .nullable(),
  )
  .default(null);

/**
 * How far away a listing is, **as a bucket rather than a number** (§8.4.1).
 *
 * §8.4.1 requires displayed distances to be coarse rather than exact, and this
 * is that rule in the type system: there is no field here that could hold a
 * decimal, so no layer above the repository can render one by accident.
 *
 * **Two cases, because "0.4 miles" and "about 0 miles away" are both wrong.**
 * Anything under a mile is simply near; everything else is a whole number of
 * miles with "about" in front of it.
 *
 * **The coarseness that protects an address is not this rounding.** Rounding to
 * the nearest mile would be thin cover on its own — a mile is a large area, but
 * repeated probes from many origins would still converge. What makes these
 * numbers safe to publish is that they are measured from the *fuzzed* point
 * (ADR 0032), which sits 500–1000 m from the truth in a direction nobody can
 * recover. This bucket keeps us from advertising precision we do not have; the
 * fuzz is what keeps the address private.
 */
export type DistanceBucket =
  | { readonly kind: 'under_a_mile' }
  | { readonly kind: 'approximate'; readonly miles: number };

export const distanceBucketSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('under_a_mile') }),
  z.object({ kind: z.literal('approximate'), miles: z.number().int().positive() }),
]);

/**
 * Where a stranger searches for listings near them (slice 3.1a).
 *
 * **The same `/public/` prefix as the listing page, and for the same reason.**
 * Every other listing path is guarded; a route anybody on the internet may call
 * has to be typed deliberately and read wrong anywhere it does not belong.
 *
 * **A collection under the path whose `:id` form is the detail page**, which is
 * the ordinary REST shape and is worth stating because the two are more
 * different than they look: this one is enumerable. `PUBLIC_LISTING_ROUTE` is
 * bounded by the UUID space, and this route is bounded by nothing at all until
 * rate limiting exists (`SECURITY.md`).
 */
export const PUBLIC_LISTING_SEARCH_ROUTE = '/public/listings';

/**
 * Built with `encodeURIComponent` rather than `URLSearchParams`, which this
 * package cannot see: `@platform/contracts` is compiled without DOM or Node
 * libs on purpose, because it is imported by the web app and the API alike and
 * a type that exists in only one of them is a build that breaks in the other.
 */
export function publicListingSearchPath(search: ListingSearchQuery): string {
  return `${PUBLIC_LISTING_SEARCH_ROUTE}?${listingSearchQueryString(search)}`;
}

/**
 * One search as a query string — **the single place either side writes one**
 * (slice 3.2a).
 *
 * Shared with the web app's own link builders through `browseHref`, so an API
 * URL and a page URL cannot disagree about how a search is spelled. They are
 * different paths carrying identical questions, and the failure of letting them
 * drift is silent on both: a parameter the other side ignores produces results
 * for a search nobody asked for.
 *
 * **Two parameters are omitted when they carry the default, and both for the
 * same reason: one search must have one URL.** `?page=1` and `?category=`
 * return exactly what the bare URL returns, so minting them creates the
 * duplicate-content problem slice 2.12 has to answer for §8.17 — and the
 * cheapest answer is not to mint them. It is also what kept slice 3.1d from
 * changing a single existing link, and what keeps this slice from doing so.
 */
export function listingSearchQueryString(search: ListingSearchQuery): string {
  const parts = [
    `postcode=${encodeURIComponent(search.postcode)}`,
    `radiusMiles=${String(search.radiusMiles)}`,
  ];

  if (search.category !== null) {
    parts.push(`category=${encodeURIComponent(search.category)}`);
  }
  if (search.page !== FIRST_SEARCH_PAGE) {
    parts.push(`page=${String(search.page)}`);
  }

  return parts.join('&');
}

/**
 * Where anybody reads the categories they can narrow a search to (slice 3.2b).
 *
 * **A public sibling of `/categories`, not a relaxation of it.** That route is
 * behind `AuthGuard` and answers a different question for a different person —
 * it carries the attribute schema and the transport options an owner needs to
 * *fill in a form*. A searcher needs a name and a value, and Browse is the page
 * a signed-out stranger meets first, so it cannot use the guarded one at all.
 *
 * **In `search.ts` rather than `listings.ts`**, beside the query it parameterises
 * rather than beside the owner's routes: this exists for the filter and for
 * nothing else, and §8.17's landing pages are the only other thing that will
 * want it.
 */
export const PUBLIC_CATEGORIES_PATH = '/public/categories';
export const PUBLIC_CATEGORIES_ROUTE = '/public/categories';

/**
 * One category, as a stranger may see it.
 *
 * **Two fields, built field by field rather than by narrowing `CategoryOption`**
 * — the rule `PublicListingSummary` records. The owner's shape carries the
 * attribute schema, the transport options and the version number, and every one
 * of those is a thing this page would have to remember not to render. Here there
 * is nothing to remember: a value for the control and a label for the person.
 *
 * **The risk level and the reportable-activity flag are absent and must stay
 * absent.** They are administrative configuration (ADR 0028) — what the platform
 * thinks of a category, not what it is called — and they live on `AdminCategory`
 * where a role and a second factor guard them.
 */
export interface PublicCategory {
  /** The stable public identity, and the value the filter carries. */
  readonly slug: string;
  /** What a person reads. Renamed by an administrator; the slug never moves. */
  readonly name: string;
}

const publicCategoriesSchema = z.object({
  categories: z.array(z.object({ slug: z.string(), name: z.string() })),
});

export function parsePublicCategories(raw: unknown): {
  readonly categories: readonly PublicCategory[];
} {
  return parseWith(publicCategoriesSchema, 'The categories response', raw);
}

/**
 * What a searcher asks, as it arrives on the query string.
 *
 * **The postcode is validated, not merely accepted.** A malformed one is a 400
 * rather than an empty page, because "no results" and "you typed that wrong" are
 * different answers and the second is the one somebody can act on. A *valid*
 * postcode nothing can place is a different case again and is deliberately not
 * an error — see `parseListingSearchQuery`'s callers.
 *
 * **`radiusMiles` defaults rather than being required.** A search URL somebody
 * pastes without it is a search, not a bad request. **`page` defaults the same
 * way**, and for a stronger reason: nobody types it, so its absence is the
 * normal case rather than an omission.
 *
 * **`category` defaults to null the same way** — the third parameter in a row
 * whose absence is the ordinary case. See `searchCategorySchema` for why an
 * *empty* one is absent too, which is the case a plain GET form produces.
 */
export const listingSearchQuerySchema = z.object({
  postcode: postcodeSchema,
  radiusMiles: searchRadiusMilesSchema.default(DEFAULT_SEARCH_RADIUS_MILES),
  page: searchPageSchema.default(FIRST_SEARCH_PAGE),
  category: searchCategorySchema,
});

/**
 * One search, as every layer names it.
 *
 * **This type is the reason slice 3.2a changed the URL builders' shape.** Before
 * it, a search was three positional arguments threaded through five functions
 * that each rebuild the query string — `publicListingSearchPath` here, and
 * `browseHref`, `nextSearchHref`, `previousSearchHref` and `widerSearchHref` in
 * the web app. Adding a fourth would have compiled everywhere while four of them
 * silently dropped the filter, and **a dropped filter is not an error**: the
 * searcher gets other categories back, with no message, no log line and nothing
 * to notice. Passing the whole search means adding a field makes the *compiler*
 * find every builder, which is the property that has to survive the price and
 * date filters behind this one.
 *
 * It is `z.infer` of the query schema rather than a hand-written interface, so
 * the thing parsed off a query string is exactly the thing that builds one.
 */
export type ListingSearchQuery = z.infer<typeof listingSearchQuerySchema>;

export function parseListingSearchQuery(raw: unknown): ListingSearchQuery {
  return parseWith(listingSearchQuerySchema, 'The search request', raw);
}

/**
 * One listing on a search results page (slice 3.1a).
 *
 * **Narrower than `PublicListing`, and built field by field rather than by
 * deleting from it.** The detail page's projection is already the narrowest view
 * of a listing in the system, so the temptation is to reuse it and drop two
 * fields — and that is exactly how a results page ends up carrying two thousand
 * characters of description per row, or the pinned attribute schema repeated
 * twenty-four times. A card renders a name, a category, a district, a price and
 * a distance.
 *
 * **What is deliberately absent, beyond the obvious:**
 *
 * - **every coordinate**, fuzzed included. A bucketed distance is a scalar an
 *   attacker must combine with an origin they chose; a point is the answer
 *   itself. Phase 3's map, if it ever has one, is a decision to take on its own
 *   rather than a field that arrived because the query already had it;
 * - **`status` and `moderationState`**, for `PublicListing`'s reason — every row
 *   here has the same value for both, so sending them would tell the internet
 *   about a moderation system;
 * - **the rate card**. §3.4.4 names listing cards specifically, so the inclusive
 *   total is the headline and the bare daily rate is not one line away from
 *   being rendered instead. It is unavailable on this shape.
 */
export interface PublicListingSummary {
  readonly id: string;
  readonly title: string;
  readonly categoryName: string;
  /** The district and the town, and nothing finer (§8.4.1). */
  readonly location: CoarseLocation;
  /**
   * Inclusive of the mandatory renter fee (§3.4.4), never null.
   *
   * Non-nullable because publication refuses a listing with no daily rate, so
   * every listing that can appear here has a price.
   */
  readonly inclusiveDailyPrice: InclusiveDailyPrice;
  /** How far from the origin the searcher gave, coarsely (§8.4.1). */
  readonly distance: DistanceBucket;
  /**
   * The consumer-law disclosure (§8.3, ADR 0043).
   *
   * **On the card as well as the detail page**, because §8.3's requirement is
   * that a renter knows who they are dealing with *before responding to the
   * advert*, and a search result is an advert. Always `private_owner` today, for
   * the reason `PublicListing.ownerStatus` gives — and carried rather than
   * assumed for the same reason.
   */
  readonly ownerStatus: OwnerStatus;
}

/**
 * A page of results, and whether it is all of them.
 *
 * **`truncated` is measured, not inferred** (ADR 0035). A page that is exactly
 * full is indistinguishable from a complete set of that size, so the server
 * probes for one more row than it needs and says which it found.
 *
 * **`radiusMiles` comes back, and that is not an echo for convenience.** It is
 * what the empty state ladders up from, and it is what makes a result page
 * honest about the question it answered — a URL with no radius is served with
 * the default, and a page that did not say so would look like a search of the
 * whole country returning four things.
 *
 * **`page` comes back for the same reason and is read the same way** (slice
 * 3.1d): it is what the pager steps from, and it is what stops a defaulted page
 * being mistaken for the only one. Together with `truncated` it is everything
 * the pager needs — there is deliberately **no total**, because counting every
 * match inside a radius is a second query over the same index for a number
 * nobody acts on, on the one route with no rate limit in front of it.
 */
export interface PublicListingSearchResults {
  readonly results: readonly PublicListingSummary[];
  /** Whether there are more results **beyond this page**. */
  readonly truncated: boolean;
  readonly radiusMiles: SearchRadiusMiles;
  /** Which page this is, one-based. */
  readonly page: number;
  /**
   * Which category this was narrowed to, or null for all of them (slice 3.2a).
   *
   * **Echoed for `radiusMiles`' reason, which applies to every defaulted
   * parameter**: absent means null, and a response that did not say which
   * question it answered reads as an answer to a different one. Here that would
   * be an unfiltered search looking like a filtered one that found little — the
   * exact misreading that would make a supply problem look like a filter
   * problem.
   *
   * The **slug**, never the id: the id is resolved on the server, is not in the
   * URL, and has no business leaving it.
   */
  readonly category: string | null;
}

const publicListingSearchResultsSchema = z.object({
  results: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      categoryName: z.string(),
      location: coarseLocationSchema,
      inclusiveDailyPrice: inclusiveDailyPriceSchema,
      distance: distanceBucketSchema,
      ownerStatus: ownerStatusSchema,
    }),
  ),
  truncated: z.boolean(),
  radiusMiles: searchRadiusMilesSchema,
  page: searchPageSchema,
  category: searchCategorySchema,
});

/**
 * Check the results on the way in.
 *
 * A plain `z.object` rather than `strictObject`, matching every other response
 * parser: the narrowing this shape exists for is enforced on the server where
 * the projection is built, and a client-side `strictObject` would turn a server
 * mistake into a blank page rather than a caught disclosure — after the
 * disclosure had already crossed the wire.
 */
export function parsePublicListingSearchResults(
  raw: unknown,
): PublicListingSearchResults {
  return parseWith(
    publicListingSearchResultsSchema,
    'The search results response',
    raw,
  );
}
