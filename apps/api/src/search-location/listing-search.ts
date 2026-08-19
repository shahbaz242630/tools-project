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
  /**
   * Words to match, or **null for no keyword** (§8.4, slice 3.3a).
   *
   * **Already trimmed, and empty is not expressible.** The contract turns a
   * blank box and a whitespace-only one into null before this point, so an
   * implementation never has to decide what an empty string means — which is
   * the kind of question two implementations answer differently.
   *
   * **Matched, never ranked.** The order of `NearbyListingPage.matches` is
   * distance and stays distance whatever this holds; see `searchKeywordSchema`
   * for why that is a product decision rather than a shortcut.
   */
  readonly keyword: string | null;
  /**
   * The period the item must be free for, or **null for any dates** (§8.4 as
   * amended, slice 4.9).
   *
   * **Calendar dates, not instants, and `to` is the inclusive last day.** This
   * port and `catalogue/listing-proximity.ts` are structurally identical by
   * design — one module states what it needs, the other what it offers, and
   * `main.ts` hands the object over whole so a field added to one and forgotten
   * on the other fails to compile at the seam. Typing this one in instants would
   * have bought a conversion and spent that property, which is worth more.
   *
   * The conversion to the half-open `[startAt, endAt)` pair the database holds
   * happens in the adapter, through `periodFromLocalDates` — the same function
   * the calendar and the quote engine use, so there is one implementation of
   * *"the 20th to the 22nd"* rather than three.
   */
  readonly dates: { readonly from: string; readonly to: string } | null;
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
