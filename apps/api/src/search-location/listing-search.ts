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

/**
 * Which slice of an ordered result set to return (slice 3.1d).
 *
 * **One object rather than two number arguments**, because `(…, 24, 24)` type
 * checks with the two the wrong way round and means something entirely
 * different — page two served as page one, or a page size of nothing. The
 * compiler cannot tell two numbers apart; it can tell two fields apart.
 *
 * **`offset` rather than a page number**, so no layer below the service knows
 * how large a page is. The repository's job is to skip rows; deciding how many
 * rows a page holds is the caller's.
 */
export interface ResultWindow {
  readonly limit: number;
  readonly offset: number;
}

/**
 * One search, as this repository takes it (slice 3.2a).
 *
 * **A request object rather than positional arguments**, for the reason
 * `ResultWindow` gives about two numbers — `originPostcode` and `categoryId` are
 * both strings, and swapping them type checks while producing a plausible empty
 * page rather than an error.
 *
 * `categoryId` is **an id, never a slug**: resolving a slug is Catalogue's, so
 * this module never joins `categories` and never learns that slugs exist. Null
 * means every category.
 */
export interface NearbySearch {
  readonly originPostcode: string;
  readonly radiusMiles: SearchRadiusMiles;
  readonly categoryId: string | null;
  readonly window: ResultWindow;
}

export interface ListingSearchRepository {
  /**
   * Publicly visible listings within `radiusMiles` of `originPostcode`, or null
   * if the origin could not be placed.
   *
   * Null covers an unrecognised postcode and an unreachable provider alike, and
   * implementations must not throw for either.
   */
  findWithin(search: NearbySearch): Promise<NearbyListingPage | null>;
}
