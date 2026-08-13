import type { SearchRadiusMiles } from '@platform/contracts';
import { Paging } from '@platform/core';
import { GeocoderUnavailableError } from '../geocoder.js';
import type { GeocodedPostcode, PostcodeGeocoder } from '../geocoder.js';
import { bucketDistance, milesToMetres } from '../distance-bucket.js';
import type { ListingSearchRepository, NearbyListingPage } from '../listing-search.js';

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

  /** Put a listing at a distance from wherever the search starts. */
  places(listingId: string, metresFromOrigin: number): this {
    this.placed.push({ listingId, metresFromOrigin });
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

  findWithin(
    originPostcode: string,
    radiusMiles: SearchRadiusMiles,
    limit: number,
  ): Promise<NearbyListingPage | null> {
    this.asked.push(originPostcode);

    if (this.unplaceable.has(originPostcode.toUpperCase())) {
      return Promise.resolve(null);
    }

    const radiusMetres = milesToMetres(radiusMiles);
    const inside = this.placed
      .filter((listing) => listing.metresFromOrigin <= radiusMetres)
      .sort(byDistanceThenId)
      // The probe the real adapter makes, so `truncated` is exercised rather
      // than assumed — a fake that returned everything would make every test of
      // the flag pass for the wrong reason.
      .slice(0, Paging.probe(limit));

    const page = Paging.fitTo(inside, limit);

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
