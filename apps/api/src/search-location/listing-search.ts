import type { DistanceBucket, SearchRadiusMiles } from '@platform/contracts';

/**
 * The repository interface BRD §4.2 requires the radius query to sit behind.
 *
 * §4.2: *"raw SQL for radius queries, confined to the Search & Location module
 * behind a repository interface."* This is that interface. It exists so the one
 * place in the system holding hand-written SQL can be faked in a test without a
 * database, and so that what the SQL is allowed to return is written down as a
 * type rather than implied by a `SELECT`.
 *
 * **Structurally identical to `catalogue/listing-proximity.ts`, and deliberately
 * not imported from it.** Catalogue states what it needs; this module states
 * what it offers; the composition root passes one straight through. That is the
 * same arrangement `LocationService` and `ListingLocator` already have, and it
 * is what keeps neither module importing the other (BRD §5.1).
 */

export interface NearbyListing {
  readonly listingId: string;
  /**
   * How far away, coarsely — **never metres** (§8.4.1, ADR 0044).
   *
   * The bucketing happens below this line so that no exact distance exists
   * above it. A port returning metres is one whose caller has to remember to
   * round, and the first caller that forgets publishes a figure precise enough
   * to be worth collecting.
   */
  readonly distance: DistanceBucket;
}

export interface NearbyListingPage {
  /** Nearest first. The caller cannot re-sort — see `ProximityPage.matches`. */
  readonly matches: readonly NearbyListing[];
  readonly truncated: boolean;
}

export interface ListingSearchRepository {
  /**
   * Publicly visible listings within `radiusMiles` of `originPostcode`, or null
   * if the origin could not be placed.
   *
   * Null covers an unrecognised postcode and an unreachable provider alike, and
   * implementations must not throw for either.
   */
  findWithin(
    originPostcode: string,
    radiusMiles: SearchRadiusMiles,
    limit: number,
  ): Promise<NearbyListingPage | null>;
}
