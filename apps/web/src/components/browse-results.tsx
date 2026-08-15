import Link from 'next/link';
import { Money } from '@platform/core';
import {
  FIRST_SEARCH_PAGE,
  SEARCH_PAGE_SIZE,
  resultsToSkip,
} from '@platform/contracts';
import type {
  ListingSearchQuery,
  PublicListingSearchResults,
  PublicListingSummary,
} from '@platform/contracts';
import { distanceLabel } from '../lib/distance';
import {
  browseHref,
  hirePath,
  nextSearchHref,
  previousSearchHref,
  widerSearchHref,
} from '../lib/page-paths';
import styles from './browse.module.css';

/**
 * What a search found (slice 3.1b).
 *
 * **A component rather than markup inside the page**, for the reason
 * `public-listing.tsx` is one: server pages in this app have no tests, and
 * everything decided here is a price, a distance or a disclosure. Those are the
 * three things that must not be verified only by looking at them.
 *
 * It receives `PublicListingSearchResults` and can therefore render nothing it
 * should not — the projection has no street lines, no coordinates and no owner.
 * **This component chooses no fields**, the sentence its two predecessors carry.
 */
export function BrowseResults({
  results,
  search,
  categoryName,
}: {
  readonly results: PublicListingSearchResults;
  /**
   * What the filtered category is called, or null (slice 3.2b).
   *
   * **The name, resolved by the page, because the API returns the slug.** The
   * response echoes `category` as the stable identity — which is what every URL
   * is built from — and a person needs the label an administrator typed. The
   * page already holds the list, so it resolves it there rather than having the
   * search response carry a second representation of the same fact.
   *
   * **Null is legitimate and is not an error**: no filter is set, or the
   * category read failed and the page is rendering without the control. The
   * empty state falls back to wording that needs no name rather than showing a
   * slug, which would be a URL segment on screen.
   */
  readonly categoryName: string | null;
  /**
   * The search these results answer (slice 3.2a).
   *
   * **The whole query rather than a prop per parameter**, so that every link
   * built below — the pager both ways, the wider radius — carries every filter
   * without this component having to remember which ones exist. A filter added
   * to the contract and forgotten here would not break a link; it would build
   * one to a *different search* that renders perfectly.
   */
  readonly search: ListingSearchQuery;
}) {
  /*
   * **One search object for the whole component, and the response wins on every
   * field it echoes** (slice 3.2a).
   *
   * The API echoes the radius, the page and the category precisely so that a
   * response says which question it answered — so those three are read from the
   * response, and only the postcode, which is not echoed, comes from the
   * request. Before this slice the heading read `results.page` while the pager
   * was handed a page separately, which is two sources for one value: they agree
   * by contract, and the day they did not, a pager would step from a page other
   * than the one on screen with nothing to show for it.
   */
  const current: ListingSearchQuery = {
    postcode: search.postcode,
    radiusMiles: results.radiusMiles,
    page: results.page,
    category: results.category,
  };

  if (results.results.length === 0) {
    /*
     * **Two different empty pages, and telling them apart is the point** (slice
     * 3.1d). Nothing on page one means nothing is near them, and the answer is
     * a wider radius. Nothing on page five means they have walked off the end of
     * a set that did have results — offering a wider radius there would be
     * telling somebody their area is empty immediately after showing them what
     * is in it.
     */
    return current.page === FIRST_SEARCH_PAGE ? (
      <NothingFound search={current} categoryName={categoryName} />
    ) : (
      <NothingFurther search={current} />
    );
  }

  const first = resultsToSkip(current.page) + 1;
  const last = first + results.results.length - 1;

  return (
    <section aria-labelledby="results-heading">
      <h2 id="results-heading" className={styles.resultsHeading}>
        {/*
          **Which results these are, once there is more than one page of them.**
          The range comes from `resultsToSkip`, the same function the API uses to
          decide what to skip — so a heading cannot describe a page other than
          the one underneath it. On page one it stays the plain count, because
          "tools 1–24" is a worse sentence than "24 tools" for the only page most
          searches will ever have.
        */}
        {current.page === FIRST_SEARCH_PAGE
          ? results.results.length === 1
            ? '1 tool near you'
            : `${String(results.results.length)} tools near you`
          : `Tools ${String(first)}–${String(last)} near you`}
      </h2>

      <ul className={styles.grid}>
        {results.results.map((listing) => (
          <li key={listing.id}>
            <ListingCard listing={listing} />
          </li>
        ))}
      </ul>

      <Pager search={current} truncated={results.truncated} />
    </section>
  );
}

/**
 * Moving between pages of results (slice 3.1d).
 *
 * **Links that navigate, not a button that appends** — and the label says so.
 * The design package drew a *"Show more"* button, which means JavaScript adding
 * to the grid in place; this page is deliberately a plain GET form with no
 * JavaScript at all, which is what makes a search shareable, the back button
 * work and the whole thing usable before hydration. A control labelled *"Show
 * more"* that in fact *replaces* what is on screen is a small lie, and BRD §15's
 * rule about controls doing what they say does not have a size exemption. So the
 * control keeps the behaviour and loses the label.
 *
 * **Both ends can be absent and neither renders a disabled control.** There is
 * no next page when the server did not find one, or when the cap is reached;
 * there is no previous page on the first. A greyed-out link that does nothing is
 * the same dead control in a different coat.
 */
function Pager({
  search,
  truncated,
}: {
  readonly search: ListingSearchQuery;
  readonly truncated: boolean;
}) {
  const previous = previousSearchHref(search);
  const next = nextSearchHref(search, truncated);

  if (previous === null && next === null) return null;

  return (
    <nav className={styles.pager} aria-label="More results">
      {previous === null ? (
        <span />
      ) : (
        <Link href={previous.href} className={styles.pagerLink} rel="prev">
          ← Previous {String(SEARCH_PAGE_SIZE)} tools
        </Link>
      )}

      {next === null ? (
        /*
          **The cap, said out loud.** `MAX_SEARCH_PAGE` exists to stop an
          uncapped offset costing us a query per page for as deep as somebody
          cares to go — but a page that simply stopped, with results still on
          screen and no control, would read as a bug. The honest answer is that
          this many results means the search was too broad.
        */
        truncated ? (
          <p className={styles.pagerEnd}>
            That is as far as we page. Try a smaller radius to narrow it down.
          </p>
        ) : (
          <span />
        )
      ) : (
        <Link href={next.href} className={styles.pagerLink} rel="next">
          Next {String(SEARCH_PAGE_SIZE)} tools →
        </Link>
      )}
    </nav>
  );
}

/**
 * Past the last page — reachable by a stale link or a hand-edited URL.
 *
 * It offers the way back rather than the way wider, which is the distinction
 * `NothingFound` cannot make: this person has already seen results.
 */
function NothingFurther({ search }: { readonly search: ListingSearchQuery }) {
  return (
    <section className={styles.empty} aria-labelledby="results-heading">
      <h2 id="results-heading" className={styles.emptyHeading}>
        Nothing more to show
      </h2>
      <p className={styles.emptyBody}>
        You have reached the end of the results.{' '}
        {/*
          **Back to the first page of *this* search**, filter included — the
          spread resets only the page. Dropping the category here would send
          somebody who paged too far into a different, wider search than the one
          they were reading.
        */}
        <Link href={browseHref({ ...search, page: FIRST_SEARCH_PAGE })}>
          Start again from the first page
        </Link>
        .
      </p>
    </section>
  );
}

/**
 * One listing on the grid.
 *
 * **The whole card is a link**, so the target is the card rather than a word
 * inside it — a 44px touch target is the minimum on a phone and a title alone is
 * about 20px tall.
 */
function ListingCard({ listing }: { readonly listing: PublicListingSummary }) {
  return (
    <Link href={hirePath(listing.id)} className={styles.card}>
      {/*
        **The no-photo block, and it is the normal state rather than a
        fallback.** Media is slice 2.6 and blocked on the domain, so every card
        looks like this today. Same treatment as the listing page: the item's
        initial on a tinted block, never a camera icon and never a grey
        rectangle.
      */}
      <span className={styles.cardMedia} aria-hidden="true">
        {listing.title.trim().charAt(0).toUpperCase()}
      </span>

      <span className={styles.cardBody}>
        <span className={styles.cardTitle}>{listing.title}</span>
        <span className={styles.cardCategory}>{listing.categoryName}</span>

        {/*
          **The district and the town, and there is nothing finer to render.**
          The projection carries no postcode and no coordinate, so this is not a
          decision the card makes — it is all there is (§8.4.1).
        */}
        <span className={styles.cardWhere}>
          {listing.location.town} · {listing.location.outwardCode}
        </span>

        {/*
          **A bucket, never a measurement.** The API returns whole miles or
          "under a mile" and `distanceLabel` cannot manufacture a decimal from
          either — which is §8.4.1's trilateration defence expressed as copy.
        */}
        <span className={styles.cardDistance}>{distanceLabel(listing.distance)}</span>

        {/*
          **The inclusive total is the headline and the bare rate is not on this
          shape at all** (§3.4.4). Drip pricing is a legal exposure rather than a
          UX preference, and §3.4.4 names listing *cards* specifically — so the
          one number on a card is the one a renter pays.
        */}
        <span className={styles.cardPrice}>
          <strong>{Money.format(listing.inclusiveDailyPrice.total)}</strong> a day
        </span>
      </span>
    </Link>
  );
}

/**
 * Nothing within this radius.
 *
 * **It offers the next radius up rather than apologising**, which is the design
 * package's behaviour and the only useful thing a search with no results can do.
 * At 100 miles it offers nothing, because a control that re-runs the identical
 * search is worse than no control.
 */
function NothingFound({
  search,
  categoryName,
}: {
  readonly search: ListingSearchQuery;
  readonly categoryName: string | null;
}) {
  const wider = widerSearchHref(search);

  return (
    <section className={styles.empty} aria-labelledby="results-heading">
      <h2 id="results-heading" className={styles.emptyHeading}>
        {/*
          **The heading names the filter when there is one**, because "nothing
          within 5 miles" is a different and much worse sentence when the reason
          is a narrowing the reader chose. Without it the honest reading — *"you
          filtered this"* — is invisible, and a searcher concludes the area is
          empty when in fact they asked a narrow question.

          It falls back to the plain wording when the *name* is unknown, which
          happens when the category read failed: the filter is still applied and
          still honest, and inventing a label from the slug would show somebody a
          URL segment.

          **The name is used exactly as an administrator typed it**, and the
          sentence is built around that rather than the other way round. The
          first version read *"No {name} within 5 miles"* and lower-cased the
          name to make it fit — which is fine for "Outdoor and gardening" and
          mangles "DIY tools" and "PPE". A category name is configuration, so its
          capitalisation is somebody's decision and not ours to normalise; "in"
          costs one word and reads correctly whatever they typed.
        */}
        {categoryName === null
          ? `Nothing within ${String(search.radiusMiles)} miles`
          : `Nothing in ${categoryName} within ${String(search.radiusMiles)} miles`}
      </h2>

      {/*
        **§8.4's "category alternatives", and dropping the filter comes before
        widening the radius.** The BRD asks an empty result to offer both. With a
        launch catalogue of one category, "try these other categories" is a list
        of nothing — so the alternative that exists is the same search without
        the narrowing, and it is offered *first* because staying local is the
        product: a renter wants the thing near them more than they want a
        different thing forty miles away.

        Only rendered when a filter is set, so an unfiltered empty search is
        unchanged from 3.1b.
      */}
      {search.category !== null && (
        <p className={styles.emptyBody}>
          <Link
            href={browseHref({ ...search, category: null, page: FIRST_SEARCH_PAGE })}
          >
            Search all categories
          </Link>{' '}
          within {String(search.radiusMiles)} miles instead.
        </p>
      )}

      {wider === null ? (
        /*
          The end of the ladder. **It says the catalogue is young rather than
          that the search failed**, because at a hundred miles the honest reading
          is that nobody near them has listed yet — and that is a supply problem
          we own, not a query they got wrong.

          **From slice 3.2b it must not say that while a filter is on**, and this
          is the one place the filter changes a *claim* rather than a control.
          "There is nothing listed near you yet" is a statement about the whole
          catalogue; with a category selected, all we know is that nothing in
          *that* category is within a hundred miles, and the rest of the
          catalogue may be full. Saying the broader thing would be telling
          somebody the platform is empty on the strength of a narrowing they
          chose — and the "Search all categories" link above is right there
          disproving it.
        */
        search.category === null ? (
          <p className={styles.emptyBody}>
            There is nothing listed near you yet. We are just getting started — if you
            have a tool sitting idle, you could be the first.
          </p>
        ) : (
          <p className={styles.emptyBody}>
            Nothing in this category is listed within a hundred miles.
          </p>
        )
      ) : (
        <p className={styles.emptyBody}>
          <Link href={wider.href}>Search within {String(wider.miles)} miles</Link>{' '}
          instead, or check the postcode.
        </p>
      )}
    </section>
  );
}
