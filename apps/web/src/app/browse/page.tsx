import type { Metadata } from 'next';
import {
  DEFAULT_SEARCH_RADIUS_MILES,
  SEARCH_CATEGORY_MESSAGE,
  listingSearchFieldsSchema,
  searchDatesSchema,
  listingSearchQuerySchema,
} from '@platform/contracts';
import type { PublicCategory, SearchRadiusMiles } from '@platform/contracts';
import { fetchListingSearch, fetchPublicCategories } from '../../lib/listings';
import { namesAnUnknownCategory } from '../../lib/search-category';
import { webEnv } from '../../lib/env';
import { BrowseSearch } from '../../components/browse-search';
import { BrowseResults } from '../../components/browse-results';
import styles from './browse.module.css';

/**
 * Search — the second page in this application a stranger can reach, and the
 * first that is a *collection* (slice 3.1b).
 *
 * **`force-dynamic`, for the reason `/hire/[id]` is.** Every result depends on a
 * postcode in the query string, and a cached page is listings that were paused,
 * rejected or delisted still being offered to strangers. Caching search is a
 * real optimisation with a real invalidation story, and the story belongs to
 * whichever slice builds it rather than being inherited from a default.
 *
 * **Indexable, like the listing page and unlike everything else here.** §8.17
 * wants local discovery crawlable. What keeps that safe is not the metadata: it
 * is that `PublicListingSummary` carries a postal district and a bucketed
 * distance and nothing finer, so there is nothing on this page for a crawler to
 * find. **2.12 owns canonical URLs and the sitemap** — this page is one of the
 * things they will describe, and a search URL per postcode is exactly the
 * duplicate-content question that slice has to answer.
 *
 * **The query is validated here rather than by round-tripping the API.** The
 * schema is the contract's own, so this is reuse rather than a second rule — and
 * it means a hand-edited URL gets a message against the field instead of a 400
 * the page would have to translate. The API validates it again regardless; that
 * is the control, and this is the courtesy.
 */
export const dynamic = 'force-dynamic';

/**
 * **Page two onwards is `noindex, follow`** (slice 3.1d).
 *
 * Browse is one of only two indexable pages in this application, and pagination
 * multiplies it into a URL space a crawler will walk: every postcode times every
 * radius times every page, all of it near-identical and none of it a landing
 * page anybody should arrive on. `follow` is the half that matters — the
 * listings on page four are still reachable and still worth indexing
 * individually, which is what §8.17 actually asks for.
 *
 * **This is the conservative default, not the answer.** Slice 2.12 owns
 * canonical URLs and the sitemap, and a search URL per postcode is the question
 * it has to settle. What this avoids meanwhile is shipping a crawl trap and
 * calling it somebody else's slice.
 *
 * **The test is whether a `page` parameter is present at all**, not what it says.
 * `?page=1` is served identically to the bare URL by design, so it is a
 * duplicate of the canonical rather than the canonical — keeping it out of the
 * index is the same decision as keeping page four out, and it needs no parsing
 * to reach.
 *
 * A function rather than the `metadata` object because it depends on the query
 * string, and Next refuses both exports from one segment.
 */
export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const params = await searchParams;

  return {
    title: 'Find a tool near you',
    description:
      'Search for tools and garden equipment to rent from people nearby. Prices include all mandatory fees.',
    robots: params.page === undefined ? undefined : { index: false, follow: true },
  };
}

export default async function BrowsePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const submitted = first(params.postcode);

  /*
   * **Fetched before anything branches, and a failure is not an error page.**
   * Every return below renders the search form, and the form needs the list to
   * draw its control — so this sits above the branches rather than being
   * repeated in each.
   *
   * **The outcome is collapsed to a list, and an empty one means "no control"**
   * (see `BrowseSearch`). Search does not depend on this read: if the category
   * endpoint is down, a searcher can still type a postcode and get results, and
   * a filter already in the URL is still applied and still honoured by every
   * link. The alternative — failing the page — would let a cosmetic outage take
   * down the one demand-side page this platform has.
   */
  const categories = await categoryOptions();

  /*
   * **Nothing typed yet is not an error.** Somebody arriving from the nav has
   * given us nothing to search with, and a page that greeted them with "that is
   * not a valid postcode" would be blaming them for having just arrived.
   */
  if (submitted === null) {
    return (
      <Page>
        <BrowseSearch
          postcode=""
          radiusMiles={DEFAULT_SEARCH_RADIUS_MILES}
          category={categoryFrom(params.category)}
          categories={categories}
          keyword={keywordFrom(params.keyword)}
          dates={datesFrom(params)}
          keywordField
          error={null}
        />
        <p className={styles.prompt}>
          Enter your postcode to see what people near you are lending.
        </p>
      </Page>
    );
  }

  const parsed = listingSearchQuerySchema.safeParse({
    postcode: submitted,
    // Absent is legitimate — the schema defaults it. A *present but wrong* value
    // is not, and falls through to the same field error, because a URL claiming
    // a 7-mile radius should not be quietly answered with a 5-mile one.
    radiusMiles: first(params.radiusMiles) ?? undefined,
    // The same treatment for the page, and the same reason: `?page=0` and
    // `?page=99` are hand-edited or stale URLs, and answering either with page
    // one would be showing somebody results they did not ask for while the
    // address bar says otherwise.
    page: first(params.page) ?? undefined,
    /*
     * **And the same again for the category** (slice 3.2a). This schema can only
     * refuse a slug that is *malformed*; one that is well formed but names no
     * category is caught below, against the list this page already holds.
     */
    category: first(params.category) ?? undefined,
    /*
     * **And the same again for the keyword** (slice 3.3b). The only thing this
     * schema refuses is a term past the length bound; nothing is rejected for
     * its content, because words we hold no listing for are an ordinary empty
     * result rather than a bad request.
     */
    keyword: first(params.keyword) ?? undefined,
    /*
     * **And the dates** (slice 4.9) — **and their absence here was a live bug
     * for the length of one manual check.**
     *
     * ADR 0046's promise is that adding a filter is a compile error in every URL
     * builder, and it kept it: five builders and both ports failed to compile
     * until they carried `dates`. **This object is where that promise stops.**
     * Zod parses `unknown`, so a field this mapping forgets is not a type error
     * — it is a filter that silently does nothing, which is precisely the
     * failure ADR 0046 exists to prevent, arriving through the one door it does
     * not cover.
     *
     * It was found by searching for dates in a browser and getting a listing
     * back that a booking already held. The API was right; this page never asked
     * it the question. **A filter added after this one must be added here too,
     * and nothing will tell you.**
     */
    availableFrom: first(params.availableFrom) ?? undefined,
    availableTo: first(params.availableTo) ?? undefined,
  });

  if (!parsed.success) {
    return (
      <Page>
        <BrowseSearch
          postcode={submitted}
          radiusMiles={radiusFrom(params.radiusMiles)}
          category={categoryFrom(params.category)}
          categories={categories}
          keyword={keywordFrom(params.keyword)}
          dates={datesFrom(params)}
          keywordField
          error={messageFor(parsed.error.issues)}
        />
      </Page>
    );
  }

  /*
   * **A well-formed slug naming no category we have, caught here rather than by
   * the API** (slice 3.2b, found by looking at the page).
   *
   * The API refuses it with a 400 — correctly, and that refusal is the control.
   * But `publicCall` maps every 400 to `unreachable`, so the page rendered
   * *"Search is unavailable at the moment"* for a URL whose only problem was a
   * category that does not exist. Search was entirely available. That is 3.1d's
   * defect exactly, one field along: **the refusal was right and the words were
   * wrong**, which is why no test caught it and reading the page did.
   *
   * The rule and its one tricky condition live in `lib/search-category.ts`,
   * where they can be tested — pages here have no tests, and the condition that
   * an *empty* list means "the read failed" rather than "there are none" is
   * exactly the kind that gets simplified away.
   */
  if (namesAnUnknownCategory(parsed.data.category, categories)) {
    return (
      <Page>
        <BrowseSearch
          postcode={parsed.data.postcode}
          radiusMiles={parsed.data.radiusMiles}
          // Reset to "all" rather than echoed: the value names nothing, so there
          // is no option to select and nothing for a person to correct by
          // reading it back — and echoing it would carry the bad slug into the
          // next submission. The postcode is echoed for the opposite reason.
          category={null}
          categories={categories}
          keyword={parsed.data.keyword}
          dates={parsed.data.dates}
          keywordField
          error={`Category ${SEARCH_CATEGORY_MESSAGE}.`}
        />
      </Page>
    );
  }

  const outcome = await fetchListingSearch(webEnv().API_BASE_URL, parsed.data);

  return (
    <Page>
      <BrowseSearch
        postcode={parsed.data.postcode}
        radiusMiles={parsed.data.radiusMiles}
        category={parsed.data.category}
        categories={categories}
        keyword={parsed.data.keyword}
        dates={parsed.data.dates}
        keywordField
        error={null}
      />

      {/*
        **`loaded` includes "we could not place your postcode", and that is
        handled inside `BrowseResults` rather than here.**

        Worth saying out loud, because the natural instinct on reading this
        branch is to add a third case beside it — and it would be the wrong
        place. An unplaceable origin is a *successful* read of a well-formed
        answer: the API looked at the request, decided it could not geocode the
        origin, and said so in `originStatus`. It is not the read failing, so it
        does not belong beside `unreachable`; and the page has no tests, while
        the component does, which is where the sentence a searcher reads should
        be pinned. See `SearchOriginStatus`.
      */}
      {outcome.kind === 'loaded' ? (
        <BrowseResults
          results={outcome.value}
          search={parsed.data}
          categoryName={nameOf(categories, outcome.value.category)}
        />
      ) : (
        /*
         * **One message for every way the read can fail**, and `not-found` is
         * among them only because the outcome type is shared — the search route
         * answers 200 with an empty list rather than 404, so it cannot arrive.
         *
         * It says the search failed rather than that nothing was found, which is
         * the distinction that matters: telling somebody their area is empty
         * when we never managed to look is the one wrong answer available here.
         */
        <p className={styles.unavailable} role="alert">
          Search is unavailable at the moment. Please try again shortly.
        </p>
      )}
    </Page>
  );
}

/**
 * The wrapper, which exists to widen the content column.
 *
 * `--page-width` defaults to the form width — 600px, which is what most of this
 * application is — and the design puts Browse at 1160px alongside the landing
 * page. Set on the page's own element, which is the mechanism `globals.css`
 * documents.
 */
function Page({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>Find a tool near you</h1>
      {children}
    </main>
  );
}

/**
 * The first value of a repeated query parameter, or null.
 *
 * `?postcode=a&postcode=b` is a real thing a crawler or a hand-edited URL
 * produces, and it arrives as an array. Taking the first is the ordinary
 * treatment; the alternative — refusing — would turn a harmless duplicate into
 * an error page.
 */
function first(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single.trim() === '' ? null : single;
}

/**
 * The categories the filter may offer, or none (slice 3.2b).
 *
 * **Every failure collapses to an empty list on purpose.** `unreachable`,
 * `malformed` and the unreachable `not-found` all mean the same thing to this
 * page: we cannot draw the control. None of them means the search is broken, and
 * none of them is worth a message — a searcher who never intended to filter
 * should not be told that a thing they were not using is unavailable.
 */
async function categoryOptions(): Promise<readonly PublicCategory[]> {
  const outcome = await fetchPublicCategories(webEnv().API_BASE_URL);
  return outcome.kind === 'loaded' ? outcome.value : [];
}

/**
 * The display name for a slug, or null if we do not have one.
 *
 * Null covers both "no filter" and "the category read failed", which the empty
 * state treats identically — it falls back to wording that needs no name rather
 * than rendering the slug, because a slug on screen is a URL segment shown to a
 * person.
 */
function nameOf(
  categories: readonly PublicCategory[],
  slug: string | null,
): string | null {
  if (slug === null) return null;
  return categories.find((category) => category.slug === slug)?.name ?? null;
}

/** What to leave in the selector when the query is refused. */
function radiusFrom(value: string | string[] | undefined): SearchRadiusMiles {
  const parsed = listingSearchFieldsSchema.shape.radiusMiles.safeParse(
    first(value) ?? undefined,
  );
  return parsed.success ? parsed.data : DEFAULT_SEARCH_RADIUS_MILES;
}

/**
 * The same, for the category (slice 3.2a).
 *
 * **A malformed category falls back to "all" rather than being echoed**, which
 * is the opposite of what the postcode field does — and deliberately. The
 * postcode is echoed because it is what the person typed and they need to see
 * it to fix it; a category is chosen from a control, so a slug that is not one
 * of ours is not something anybody can correct by reading it back. Putting it
 * into the form would also mean the next submission carries the same broken
 * value forward.
 */
function categoryFrom(value: string | string[] | undefined): string | null {
  const parsed = listingSearchFieldsSchema.shape.category.safeParse(
    first(value) ?? undefined,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The same, for the keyword (slice 3.3b).
 *
 * **A too-long keyword falls back to empty rather than being echoed**, and this
 * one sits between the other two rather than following either. Like the
 * postcode it is text a person typed, so the instinct is to echo it; like the
 * category it is the thing being refused, and echoing it would put a value back
 * in the box that the next submission would be refused for again — with the
 * error still showing and nothing on screen explaining that the box itself is
 * the problem. The only way to reach this is a hand-edited or stale URL, since
 * the input carries `maxLength`.
 */
/**
 * The same, for the dates (slice 4.9).
 *
 * **It takes the whole params object, unlike the three above**, because the
 * filter is a pair: `searchDatesSchema` refuses one date without the other, so
 * salvaging them one at a time would be the very shape the contract exists to
 * make unrepresentable.
 *
 * **A refused range is dropped rather than echoed**, which is the category's
 * treatment rather than the postcode's. Both dates come from a picker, so a
 * range the parser rejected is not something a person can fix by reading it
 * back — and leaving it in the form would mean the next submission is refused
 * for the same reason, with the error still showing.
 */
function datesFrom(
  params: Record<string, string | string[] | undefined>,
): { from: string; to: string } | null {
  const parsed = searchDatesSchema.safeParse({
    availableFrom: first(params['availableFrom']) ?? undefined,
    availableTo: first(params['availableTo']) ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}

function keywordFrom(value: string | string[] | undefined): string | null {
  const parsed = listingSearchFieldsSchema.shape.keyword.safeParse(
    first(value) ?? undefined,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * What each field is called when something is wrong with it.
 *
 * A map rather than a conditional, which is what slice 3.1d's third field
 * forced: the previous version read *"postcode or else radius"*, so a page
 * problem would have been reported as a radius one — the label silently wrong
 * while the message was right.
 */
const FIELD_LABELS: Record<string, string> = {
  postcode: 'Postcode',
  radiusMiles: 'Radius',
  page: 'Page',
  category: 'Category',
  // "Search" rather than "Keyword", because that is what the control is called
  // on screen — "What are you looking for?" — and nobody reading a message
  // about a "keyword" would know which box it meant. The map's keys are the
  // contract's field names; its values are the page's own words.
  keyword: 'Search',
};

/**
 * The one message worth showing, in the field's own words.
 *
 * The postcode is the field somebody can actually fix, so its message wins when
 * more than one is wrong — a page reporting a radius problem to somebody who
 * mistyped their postcode is a page pointing at the wrong control.
 */
function messageFor(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  const postcode = issues.find((issue) => issue.path[0] === 'postcode');
  const chosen = postcode ?? issues[0];
  if (chosen === undefined) return 'That search is not valid.';

  const label = FIELD_LABELS[String(chosen.path[0])] ?? 'That search';
  return `${label} ${chosen.message}.`;
}
