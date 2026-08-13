import {
  DEFAULT_SEARCH_RADIUS_MILES,
  listingSearchQuerySchema,
} from '@platform/contracts';
import type { SearchRadiusMiles } from '@platform/contracts';
import { fetchListingSearch } from '../../lib/listings';
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

export const metadata = {
  title: 'Find a tool near you',
  description:
    'Search for tools and garden equipment to rent from people nearby. Prices include all mandatory fees.',
};

export default async function BrowsePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const submitted = first(params.postcode);

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
  });

  if (!parsed.success) {
    return (
      <Page>
        <BrowseSearch
          postcode={submitted}
          radiusMiles={radiusFrom(params.radiusMiles)}
          error={messageFor(parsed.error.issues)}
        />
      </Page>
    );
  }

  const outcome = await fetchListingSearch(
    webEnv().API_BASE_URL,
    parsed.data.postcode,
    parsed.data.radiusMiles,
  );

  return (
    <Page>
      <BrowseSearch
        postcode={parsed.data.postcode}
        radiusMiles={parsed.data.radiusMiles}
        error={null}
      />

      {outcome.kind === 'loaded' ? (
        <BrowseResults
          results={outcome.value}
          postcode={parsed.data.postcode}
          radiusMiles={parsed.data.radiusMiles}
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

/** What to leave in the selector when the query is refused. */
function radiusFrom(value: string | string[] | undefined): SearchRadiusMiles {
  const parsed = listingSearchQuerySchema.shape.radiusMiles.safeParse(
    first(value) ?? undefined,
  );
  return parsed.success ? parsed.data : DEFAULT_SEARCH_RADIUS_MILES;
}

/**
 * The one message worth showing, in the field's own words.
 *
 * The postcode is the field somebody can actually fix, so its message wins when
 * both are wrong — a page reporting a radius problem to somebody who mistyped
 * their postcode is a page pointing at the wrong control.
 */
function messageFor(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  const postcode = issues.find((issue) => issue.path[0] === 'postcode');
  const chosen = postcode ?? issues[0];

  return chosen === undefined
    ? 'That search is not valid.'
    : `${chosen.path[0] === 'postcode' ? 'Postcode' : 'Radius'} ${chosen.message}.`;
}
