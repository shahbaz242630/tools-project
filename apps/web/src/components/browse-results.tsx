import Link from 'next/link';
import { Money } from '@platform/core';
import type {
  PublicListingSearchResults,
  PublicListingSummary,
  SearchRadiusMiles,
} from '@platform/contracts';
import { distanceLabel } from '../lib/distance';
import { hirePath, widerSearchHref } from '../lib/page-paths';
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
  postcode,
  radiusMiles,
}: {
  readonly results: PublicListingSearchResults;
  readonly postcode: string;
  readonly radiusMiles: SearchRadiusMiles;
}) {
  if (results.results.length === 0) {
    return <NothingFound postcode={postcode} radiusMiles={radiusMiles} />;
  }

  return (
    <section aria-labelledby="results-heading">
      <h2 id="results-heading" className={styles.resultsHeading}>
        {results.results.length === 1
          ? '1 tool near you'
          : `${String(results.results.length)} tools near you`}
      </h2>

      <ul className={styles.grid}>
        {results.results.map((listing) => (
          <li key={listing.id}>
            <ListingCard listing={listing} />
          </li>
        ))}
      </ul>

      {/*
        **The honest half of a page that has no "Show more" yet** (slice 3.1c).
        A list that stops without saying so is one somebody reads as everything
        there is, and `truncated` is measured by the server rather than inferred
        from a full page — so this sentence is the only thing standing between a
        bounded read and a wrong impression. The cursor is a separate slice
        because a keyset cursor on distance would have to carry an exact
        distance, which is the precision §8.4.1 exists to remove.
      */}
      {results.truncated && (
        <p className={styles.truncated}>
          Showing the first {String(results.results.length)}. Try a smaller radius to
          narrow it down.
        </p>
      )}
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
  postcode,
  radiusMiles,
}: {
  readonly postcode: string;
  readonly radiusMiles: SearchRadiusMiles;
}) {
  const wider = widerSearchHref(postcode, radiusMiles);

  return (
    <section className={styles.empty} aria-labelledby="results-heading">
      <h2 id="results-heading" className={styles.emptyHeading}>
        Nothing within {String(radiusMiles)} miles
      </h2>

      {wider === null ? (
        /*
          The end of the ladder. **It says the catalogue is young rather than
          that the search failed**, because at a hundred miles the honest reading
          is that nobody near them has listed yet — and that is a supply problem
          we own, not a query they got wrong.
        */
        <p className={styles.emptyBody}>
          There is nothing listed near you yet. We are just getting started — if you
          have a tool sitting idle, you could be the first.
        </p>
      ) : (
        <p className={styles.emptyBody}>
          <Link href={wider.href}>Search within {String(wider.miles)} miles</Link>{' '}
          instead, or check the postcode.
        </p>
      )}
    </section>
  );
}
