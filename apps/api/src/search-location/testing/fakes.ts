import { Paging } from '@platform/core';
import { GeocoderUnavailableError } from '../geocoder.js';
import type { GeocodedPostcode, PostcodeGeocoder } from '../geocoder.js';
import { bucketDistance, milesToMetres } from '../distance-bucket.js';
import type {
  ListingSearchRepository,
  NearbyListingPage,
  NearbySearch,
  ResultWindow,
} from '../listing-search.js';

/**
 * Test doubles for Search & Location.
 *
 * BRD §5 requires a fake alongside every provider adapter. This one is
 * *behavioural* rather than a recording spy: it answers from a seeded table and
 * returns null for anything it has not been told about, so a test that forgets
 * to seed sees the "not recognised" path rather than a convenient default. That
 * is the same rule the identity fakes follow, and it matters more here — the
 * "not recognised" path is the one production hits for real postcodes the
 * provider's snapshot has not caught up with.
 */
export class FakeGeocoder implements PostcodeGeocoder {
  private readonly known = new Map<string, GeocodedPostcode>();
  private failure: GeocoderUnavailableError | null = null;
  /** Every postcode it was asked about, so a test can assert it was not asked twice. */
  readonly asked: string[] = [];

  /** Real coordinates for a real postcode, so fixtures are not fiction. */
  static readonly BS7_8AA: GeocodedPostcode = {
    postcode: 'BS7 8AA',
    latitude: 51.470761,
    longitude: -2.593052,
  };

  /**
   * A second real one, twelve miles away, for the tests that move a listing
   * (slice 2.9b-ii).
   *
   * Far enough apart that a published point computed from the wrong one is
   * unmistakable — the fuzz is 500–1000 m and this is 19 km, so no offset can
   * make Bath look like Bristol.
   */
  static readonly BA1_1AA: GeocodedPostcode = {
    postcode: 'BA1 1AA',
    latitude: 51.381428,
    longitude: -2.35897,
  };

  knows(located: GeocodedPostcode): this {
    this.known.set(located.postcode.toUpperCase(), located);
    return this;
  }

  /**
   * Make the **next** call fail, once.
   *
   * Once rather than permanently, so a test can assert that a later save
   * succeeds — which is the whole degradation story: a provider outage costs a
   * listing its coordinates until somebody saves again.
   */
  failsOnce(message = 'The geocoder could not be reached'): this {
    this.failure = new GeocoderUnavailableError(message);
    return this;
  }

  locate(postcode: string): Promise<GeocodedPostcode | null> {
    this.asked.push(postcode);

    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }

    return Promise.resolve(this.known.get(postcode.toUpperCase()) ?? null);
  }
}

/** A listing at a known distance, as a test places one. */
export interface PlacedListing {
  readonly listingId: string;
  /** From the origin, in metres. What the real query gets back from PostGIS. */
  readonly metresFromOrigin: number;
  /**
   * Which category it is in (slice 3.2a).
   *
   * **Null means "in no category a filter can name"**, which is what a listing
   * placed by a test that does not care about categories gets. It is not the
   * same as the *search's* null: an unfiltered search matches everything
   * including these, and a filtered one matches none of them. A test that wants
   * a listing to survive a category filter has to say which category it is in,
   * which is the right way round — the alternative would let a filter test pass
   * against a fixture that was never categorised.
   */
  readonly categoryId: string | null;
}

/**
 * The radius query, without PostGIS (slice 3.1a).
 *
 * **It fakes the geometry and reproduces everything else exactly**, which is the
 * division that makes it useful rather than circular. Distances are given rather
 * than computed — a fake that re-implemented the great-circle formula would only
 * prove the two implementations agree — but the radius comparison, the probe,
 * the truncation flag, the nearest-first order and the bucketing all run the
 * real code. Those are the parts a service can get wrong.
 *
 * **What it cannot prove is exactly what the db test exists for**: that the SQL
 * filters on the fuzzed point, joins the right tables, and returns no column it
 * should not. Nothing in here would notice if that statement selected a street
 * line.
 */
export class FakeListingSearch implements ListingSearchRepository {
  private readonly placed: PlacedListing[] = [];
  private readonly unplaceable = new Set<string>();
  /** Every origin it was asked about, in order. */
  readonly asked: string[] = [];
  /**
   * Every window it was asked for, in order (slice 3.1d).
   *
   * Recorded because the offset is the one thing a service can get wrong that
   * the results would not reveal: asking for page two with an offset of zero
   * returns a perfectly plausible page of the wrong rows.
   */
  readonly windows: ResultWindow[] = [];

  /**
   * Every category it was asked to narrow to, in order (slice 3.2a).
   *
   * Recorded for the reason `windows` is: a service that resolves a slug to the
   * wrong id, or drops the filter on the way down, returns a page that looks
   * entirely reasonable. Asserting on the results alone cannot tell "the filter
   * was applied and matched everything" from "the filter was never passed".
   */
  readonly categories: (string | null)[] = [];

  /** Put a listing at a distance from wherever the search starts. */
  places(
    listingId: string,
    metresFromOrigin: number,
    categoryId: string | null = null,
  ): this {
    this.placed.push({ listingId, metresFromOrigin, categoryId });
    return this;
  }

  /**
   * Make this origin unplaceable — the null case.
   *
   * By postcode rather than a global switch, so a test can assert that one
   * search fails to place its origin while another succeeds, which is the shape
   * of a real geocoder that does not recognise a new build's postcode.
   */
  cannotPlace(postcode: string): this {
    this.unplaceable.add(postcode.toUpperCase());
    return this;
  }

  findWithin(search: NearbySearch): Promise<NearbyListingPage | null> {
    const { window } = search;

    this.asked.push(search.originPostcode);
    this.windows.push(window);
    this.categories.push(search.categoryId);

    if (this.unplaceable.has(search.originPostcode.toUpperCase())) {
      return Promise.resolve(null);
    }

    const radiusMetres = milesToMetres(search.radiusMiles);
    const inside = this.placed
      .filter((listing) => listing.metresFromOrigin <= radiusMetres)
      /*
       * **The filter runs before the skip, exactly as the SQL does** (slice
       * 3.2a). Filtering after slicing would be the filter-after-paginate bug
       * modelled into the fake, so a service that produced it would pass — and
       * the fake would be certifying the defect the port's docblock exists to
       * forbid.
       */
      .filter(
        (listing) =>
          search.categoryId === null || listing.categoryId === search.categoryId,
      )
      .sort(byDistanceThenId)
      /*
       * **The skip, then the probe** — the real statement's `OFFSET` and `LIMIT`
       * in the order Postgres applies them (slice 3.1d). Slicing before sorting,
       * or probing before skipping, would both produce a fake that paginates
       * something other than what ships.
       */
      .slice(window.offset, window.offset + Paging.probe(window.limit));

    const page = Paging.fitTo(inside, window.limit);

    return Promise.resolve({
      matches: page.items.map((listing: PlacedListing) => ({
        listingId: listing.listingId,
        distance: bucketDistance(listing.metresFromOrigin),
      })),
      truncated: page.truncated,
    });
  }
}

/** The adapter's `ORDER BY`, including its tiebreak on id. */
function byDistanceThenId(a: PlacedListing, b: PlacedListing): number {
  return (
    a.metresFromOrigin - b.metresFromOrigin || a.listingId.localeCompare(b.listingId)
  );
}
