import { z } from 'zod';
import { Time } from '@platform/core';
import { calendarDateSchema } from './availability.js';
import { MAX_MAXIMUM_RENTAL_DAYS } from './catalogue.js';
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
 * Narrowing a search to words — **BRD §8.4's free-text filter** (slice 3.3a).
 *
 * **A filter, never a ranking input, and that is the decision this whole slice
 * turns on.** Results stay ordered by distance. §8.4 requires ranking to be
 * *explainable*, and "nearest first, matching your words" is a sentence a person
 * can be told; a blended relevance-times-distance score is one nobody can be
 * told and nobody can predict. It also keeps `ORDER BY metres, id` intact, which
 * is what ADR 0045 rests on for correct paging — a relevance sort would need its
 * own tiebreak and would change page stability, silently, on a set that moves.
 *
 * **Absent, empty and whitespace all mean "no keyword"**, exactly as
 * `searchCategorySchema` treats a slug and for the same reason: Browse submits a
 * plain GET form, so an empty box is the *ordinary* case rather than an error,
 * and 400-ing it would refuse the commonest search on the page. Whitespace is
 * trimmed rather than searched — `websearch_to_tsquery` would find nothing for
 * it, which is an empty page that looks like a fact about the area.
 *
 * **Length-bounded, and that is a denial-of-service control rather than a form
 * rule.** This is the one public route that answers with a collection, from an
 * origin the caller chooses, with no rate limiting anywhere in front of it
 * (`SECURITY.md`) — so nothing unbounded from a query string should reach the
 * query planner. A hundred characters is far past any real search and far short
 * of anything expensive.
 *
 * **No message about *what* was wrong, deliberately.** Slice 3.1d's lesson: the
 * only thing worth telling somebody who pasted an over-long URL is that it is
 * too long to search for, not which internal bound it crossed.
 */
export const MAX_SEARCH_KEYWORD_LENGTH = 100;

export const SEARCH_KEYWORD_MESSAGE = `must be ${String(MAX_SEARCH_KEYWORD_LENGTH)} characters or fewer`;

export const searchKeywordSchema = z
  .preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }, z.string(SEARCH_KEYWORD_MESSAGE).max(MAX_SEARCH_KEYWORD_LENGTH, SEARCH_KEYWORD_MESSAGE).nullable())
  .default(null);

/**
 * Whether we managed to place the origin at all — **the difference between "we
 * looked and found nothing" and "we never looked"**.
 *
 * **This is the field slice 3.1a promised and 3.1b never built.** The API
 * deliberately answers an unplaceable origin with a 200 and an empty list, and
 * that part is right: the postcode was well formed so a 400 would be wrong, and
 * a third party's outage is not ours to return as a 500. What was missing is
 * that the *reason* stopped at the controller. `results: []` is a claim about
 * the world, and the page rendered it as one — *"There is nothing listed near
 * you yet. We are just getting started"* — so an hour of postcodes.io being down
 * was served to every searcher as a confident statement that the catalogue is
 * empty. Nothing alerted, because from outside it looked exactly like a quiet
 * area, which is `geocode_duration_seconds{outcome="unavailable"}`'s whole
 * reason for existing.
 *
 * - **`placed`** — the origin geocoded and the radius query ran. An empty
 *   `results` here is a fact about the area.
 * - **`unplaceable`** — the origin did not geocode, so no radius query ran at
 *   all. `results` is empty because there was nowhere to search *from*, and it
 *   says nothing whatever about what is near that postcode.
 *
 * **Two values rather than three, and the missing third is deliberate.** A
 * geocoder that is *down* and a valid postcode the geocoder does not *recognise*
 * want different advice — "try again shortly" against "check the postcode" — and
 * the difference does exist: `geocodeQuietly` distinguishes them and records
 * both on `geocode_duration_seconds`. It is collapsed to one null before it
 * reaches Catalogue, by `ListingProximity`, whose docblock argues for the
 * collapse. Carrying it further is a change to that port, to
 * `ListingSearchRepository` behind it and to the composition root that joins
 * them — worth doing, and a wider change than this one. **When it happens, this
 * union grows to `'placed' | 'unknown_postcode' | 'geocoder_unavailable'` and
 * every reader becomes a compile error**, which is the point of a closed union
 * rather than a boolean.
 *
 * **A closed vocabulary, and it must stay closed for a second reason**: BRD §17's
 * zero-result rate is computed from search outcomes, and a status a caller can
 * invent is a series a caller can invent. See `ListingSearchOutcome` in
 * `@platform/observability`, which is the metric side of the same fact and is
 * held closed by the compiler for exactly that reason.
 */
export const SEARCH_ORIGIN_STATUSES = ['placed', 'unplaceable'] as const;
export type SearchOriginStatus = (typeof SEARCH_ORIGIN_STATUSES)[number];
export const searchOriginStatusSchema = z.enum(SEARCH_ORIGIN_STATUSES);

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
 * **Three parameters are omitted when they carry the default, and all for the
 * same reason: one search must have one URL.** `?page=1`, `?category=` and
 * `?keyword=` return exactly what the bare URL returns, so minting them creates
 * the duplicate-content problem slice 2.12 has to answer for §8.17 — and the
 * cheapest answer is not to mint them. It is also what kept slice 3.1d from
 * changing a single existing link, and what keeps this slice from doing so.
 *
 * **The keyword is written first, before the filters that narrow it.** Nothing
 * depends on the order — both sides parse by name — but a URL is read by people
 * as well as parsed, and the words somebody typed are the most legible thing in
 * it. Fixed here rather than left to insertion order so two identical searches
 * cannot produce two different strings.
 */
export function listingSearchQueryString(search: ListingSearchQuery): string {
  const parts = [
    `postcode=${encodeURIComponent(search.postcode)}`,
    `radiusMiles=${String(search.radiusMiles)}`,
  ];

  if (search.keyword !== null) {
    parts.push(`keyword=${encodeURIComponent(search.keyword)}`);
  }
  if (search.category !== null) {
    parts.push(`category=${encodeURIComponent(search.category)}`);
  }
  if (search.page !== FIRST_SEARCH_PAGE) {
    parts.push(`page=${String(search.page)}`);
  }
  /*
   * **Both or neither, which the type already guarantees** (slice 4.9). The pair
   * is one field precisely so this cannot write one parameter and forget the
   * other — a half-range in a URL is a search the parser then refuses, and the
   * searcher would see a 400 for a link the page itself minted.
   *
   * **Omitted entirely when absent**, like the three above and for the same
   * reason: one search, one URL. An undated search must not mint a second
   * address for the page slice 2.12 has to declare canonical.
   */
  if (search.dates !== null) {
    parts.push(`availableFrom=${search.dates.from}`);
    parts.push(`availableTo=${search.dates.to}`);
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
 *
 * **`keyword` is the fourth and the only one a person types free-hand** (slice
 * 3.3a). Same absent-means-all treatment, and see `searchKeywordSchema` for why
 * it is bounded and why it is a filter rather than a sort.
 */
/** Treat a blank or whitespace-only parameter as though it were not sent. */
function blankIsAbsent<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

/**
 * The dates a searcher wants the item for (BRD §8.4 as amended, slice 4.9).
 *
 * **A pair or nothing, and never half of one.** Two independent nullable fields
 * would make `availableFrom` without `availableTo` representable, and every
 * layer downstream would then have to decide what a half-range means — which is
 * three places to decide it and two of them wrong. The parse collapses the two
 * query parameters into one value, so a URL builder cannot emit half a filter
 * and the SQL cannot be handed one.
 *
 * **Inclusive at both ends**, as every date on this platform's wires is: "the
 * 20th to the 22nd" is three days and the last one is the 22nd. The conversion
 * to the half-open pair the database holds happens once, on the server.
 *
 * **Bounded by the statutory ceiling** rather than left open. §8.5.3 makes 88
 * days the longest hire anybody may agree to anywhere on the platform — a hire
 * *capable of subsisting* beyond three months is regulated consumer hire under
 * the CCA 1974 — so a longer search is asking for something no listing can
 * answer. Refusing it with a sentence is better than running a query guaranteed
 * to return nothing, which would read as *there is nothing near you*.
 */
export const searchDatesSchema = z
  .object({
    /*
     * **Blank is absent, not a bad date.** A plain GET form submits every named
     * control, so an untouched pair of date inputs sends
     * `availableFrom=&availableTo=` — and refusing that would 400 the most
     * ordinary search on the page. It is the same case `searchCategorySchema`
     * swallows for the "All categories" option, and it is preprocessed here for
     * the same reason: the alternative is a form that cannot be submitted
     * without touching a filter nobody wanted.
     */
    availableFrom: blankIsAbsent(calendarDateSchema),
    availableTo: blankIsAbsent(calendarDateSchema),
  })
  .superRefine((value, context) => {
    const from = value.availableFrom;
    const to = value.availableTo;

    if ((from === undefined) !== (to === undefined)) {
      context.addIssue({
        code: 'custom',
        // Named on the field that is missing, so a form can put the message
        // beside the control somebody has to fix.
        path: [from === undefined ? 'availableFrom' : 'availableTo'],
        message: 'give both dates or neither',
      });
      return;
    }
    if (from === undefined || to === undefined) return;

    // String comparison is date comparison for `YYYY-MM-DD`, which is the one
    // useful property of the format and the reason it is the format.
    if (to < from) {
      context.addIssue({
        code: 'custom',
        path: ['availableTo'],
        message: 'the last day cannot fall before the first',
      });
      return;
    }

    if (
      Time.rentalDayCount(Time.startOfLocalDay(from), Time.startOfLocalDay(to)) + 1 >
      MAX_MAXIMUM_RENTAL_DAYS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['availableTo'],
        message: `a hire cannot run longer than ${String(MAX_MAXIMUM_RENTAL_DAYS)} days`,
      });
    }
  })
  .transform((value) =>
    value.availableFrom === undefined || value.availableTo === undefined
      ? null
      : { from: value.availableFrom, to: value.availableTo },
  );

export type SearchDates = z.infer<typeof searchDatesSchema>;

/**
 * The fields a search carries one at a time, as an object that keeps its
 * `.shape`.
 *
 * **Separate from the full schema because the browse page salvages fields
 * individually.** When a whole query is refused, that page re-parses each field
 * on its own to decide what to leave in the form — a bad category falls back to
 * "all" while the postcode is echoed back for the person to fix. Zod's
 * intersection has no `.shape`, so folding the dates in directly would have
 * taken that away; naming the object is what keeps both.
 */
export const listingSearchFieldsSchema = z.object({
  postcode: postcodeSchema,
  radiusMiles: searchRadiusMilesSchema.default(DEFAULT_SEARCH_RADIUS_MILES),
  page: searchPageSchema.default(FIRST_SEARCH_PAGE),
  category: searchCategorySchema,
  keyword: searchKeywordSchema,
});

export const listingSearchQuerySchema = listingSearchFieldsSchema
  /*
   * **The dates are parsed from the same object and folded in**, rather than
   * declared as a field beside the others, because they are two parameters that
   * become one value. `z.object` cannot express that on its own; the intersection
   * lets the pair keep its own refinements and still arrive as `search.dates`.
   */
  .and(searchDatesSchema.transform((dates) => ({ dates })));

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
  /**
   * Which words this was narrowed by, or null for none (slice 3.3a).
   *
   * **Echoed for `category`'s reason, and it matters more here.** A page that
   * found nothing has to say whether it was looking for something in
   * particular: without this field, "no tools near you" and "no tools matching
   * *hedge trimmer* near you" are the same response, and the first is a claim
   * about the area we would be making on no evidence. It is also what the empty
   * state offers to drop.
   *
   * **The trimmed keyword, exactly as it was searched for** — not as it was
   * typed. A searcher who typed trailing spaces gets back what actually ran, so
   * the page cannot echo one thing while having queried another.
   */
  readonly keyword: string | null;
  /**
   * Whether we could place the origin — **read this before reading `results`**.
   *
   * `results: []` means two opposite things and this is the field that separates
   * them. With `placed` it is a fact about the area and the page may say so; with
   * `unplaceable` the search never ran, and any sentence about what is or is not
   * near that postcode is invented. See `SearchOriginStatus`.
   *
   * **Required rather than defaulted, which is the same argument `page` won.**
   * A response that forgets to say is the exact defect this field was added for
   * — an absent statement read as a confident one — so it is refused at the
   * parser rather than assumed to be `placed`. The cost is that a version skew
   * between the two containers renders *"Search is unavailable at the moment"*
   * for a few seconds during a deploy, which is the honest failure; the
   * alternative fails open into the bug.
   */
  /**
   * Which dates this was narrowed to, or null for any (slice 4.9).
   *
   * **Echoed for `category`'s and `keyword`'s reason**: a response that did not
   * say which question it answered reads as an answer to a different one. Here
   * that would be a dated search looking like an undated one that found little —
   * *"nothing near you"* when the truth is *"nothing near you free that week"*,
   * which is a claim about the area we would be making on no evidence.
   *
   * It is also what the pager reads to keep its links pointing at the search
   * that actually ran, and what the empty state offers to drop.
   */
  readonly dates: { readonly from: string; readonly to: string } | null;
  readonly originStatus: SearchOriginStatus;
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
  keyword: searchKeywordSchema,
  // No `.default`, unlike `category` two lines up, and the asymmetry is the
  // decision rather than an oversight: an absent category legitimately means
  // "all of them", whereas an absent origin status means the server did not
  // tell us whether it looked — which is precisely the thing that must never be
  // guessed. Same treatment as `page`, for the same reason.
  /** The period searched for, or null for any (slice 4.9). Dates, never instants. */
  dates: z.object({ from: calendarDateSchema, to: calendarDateSchema }).nullable(),
  originStatus: searchOriginStatusSchema,
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
