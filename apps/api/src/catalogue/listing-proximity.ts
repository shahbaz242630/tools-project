import type { DistanceBucket, SearchRadiusMiles } from '@platform/contracts';

/**
 * What Catalogue needs in order to ask "which listings are near here?"
 * (slice 3.1a, ADR 0044).
 *
 * **Stated by the consumer, answered by Search & Location** — the same direction
 * as `ListingLocator` and `OwnerStatusSource`. Catalogue owns listings; it does
 * not own postcodes, coordinates or PostGIS, and it does not import the module
 * that does. The composition root wires the two together.
 *
 * Three things about this port are the decision rather than the implementation,
 * and ADR 0044 has the argument for each:
 *
 * 1. **It takes a postcode, not a point.** Geocoding the searcher's origin
 *    happens on the other side of this boundary, so no bare coordinate ever
 *    crosses it. The alternative — Catalogue geocoding the origin and passing a
 *    pair in — needs `LocationService.geocode` to be public, and the docblock
 *    explaining why it is private predicts what happens next.
 * 2. **It returns a bucket, not metres.** §8.4.1 requires coarse distances, and
 *    a port handing back an exact figure is one whose caller has to remember to
 *    round. No exact distance exists above the repository to be logged, cached
 *    or serialised by accident.
 * 3. **It returns ids, not listings.** The public projection is Catalogue's, and
 *    a second module able to assemble one is a second place for it to drift.
 */

/** One listing found near the origin. */
export interface ProximityMatch {
  readonly listingId: string;
  /** How far, coarsely (§8.4.1). Measured from the fuzzed point (ADR 0032). */
  readonly distance: DistanceBucket;
}

/**
 * What one search found.
 *
 * **`truncated` rather than a total.** Counting every match inside a radius is a
 * second query over the same index for a number nobody acts on, and it would
 * grow with the catalogue on the one route with no rate limit in front of it. A
 * probe for one extra row answers the only question the page asks.
 */
/**
 * Which slice of the ordered matches to return (slice 3.1d).
 *
 * **One object rather than two numbers**, because `(…, 24, 24)` type checks with
 * them the wrong way round and means something else entirely. The compiler
 * cannot tell two numbers apart; it can tell two fields apart.
 *
 * **An offset, not a page number.** How many results make a page is Catalogue's
 * decision (`limits.ts`), and Search & Location has no business knowing it —
 * this port asks for rows and says where to start.
 */
export interface ResultWindow {
  readonly limit: number;
  readonly offset: number;
}

/**
 * One search, as this port takes it (slice 3.2a).
 *
 * **A request object rather than four positional arguments, and the reason is
 * the same one `ResultWindow` gives about two numbers.** `originPostcode` and
 * `categoryId` are both `string`, so a signature carrying them side by side type
 * checks with them the wrong way round — and the result is not an error but a
 * plausible empty page: nothing is near the postcode "8fe74923-…", and no
 * category is named "BS7 8AA". The compiler cannot tell two strings apart; it
 * can tell two fields apart.
 *
 * It is also the shape the filters behind this one need. §8.4 lists price,
 * rating, delivery and verified-owner status beside category, and dates arrive
 * with Phase 4's calendar — each of those is a field here rather than another
 * argument every call site has to be edited to pass.
 */
export interface ProximitySearch {
  readonly originPostcode: string;
  readonly radiusMiles: SearchRadiusMiles;
  /**
   * Narrow to one category, or **null for all of them** (§8.4, slice 3.2a).
   *
   * **An id, not a slug**, and that is where the module boundary is drawn.
   * Catalogue owns categories, so Catalogue resolves the slug a searcher gave
   * into the id this predicate needs — and Search & Location never learns that
   * slugs exist, never joins `categories`, and gains exactly one more column of
   * Catalogue's table to compare (ADR 0044's concession, extended by the
   * narrowest step available).
   *
   * **Null is "no filter", never "a category that does not exist".** An
   * unresolvable slug is refused above this port, because answering it with an
   * unfiltered search would show somebody every category while their URL says
   * one.
   */
  readonly categoryId: string | null;
  readonly window: ResultWindow;
}

export interface ProximityPage {
  /**
   * Matches, **nearest first**, at most the requested limit.
   *
   * The order is part of the contract because the caller cannot reproduce it:
   * exact distances do not cross this boundary, so nothing above can re-sort.
   * That is deliberate — it means there is exactly one implementation of "which
   * of these is nearest", and it is the one measuring from the fuzzed point.
   */
  readonly matches: readonly ProximityMatch[];
  readonly truncated: boolean;
}

export interface ListingProximity {
  /**
   * Publicly visible listings within `radiusMiles` of `originPostcode`, nearest
   * first — or **null if the origin could not be placed**.
   *
   * **Null is not an error and must not become one.** A postcode that is
   * well-formed but unknown to the geocoder, and a geocoder that is briefly
   * unreachable, are both "we cannot search from there" — the same one-null rule
   * `ListingLocator` follows, and for the same reason: two failure modes a
   * caller would treat identically is how one of them eventually gets handled
   * wrongly. Implementations must not throw for an unreachable provider.
   *
   * **"Publicly visible" is the implementation's job, not the caller's**, and it
   * is the half of this port that reads oddly without ADR 0044. Filtering after
   * the geo query would be the filter-after-paginate bug in its purest form:
   * ask for twenty-four, discard the drafts — which is most listings — and show
   * four, with a truncation flag that has quietly stopped meaning anything.
   *
   * The rule this applies is `status` and `moderationState` only. The third
   * authority (ADR 0043) lives in another module's table and is applied by
   * Catalogue on hydration; ADR 0044 records why the two are treated
   * differently.
   *
   * **`categoryId` is applied here for that same reason** (slice 3.2a).
   * Filtering by category after the geo query would be the filter-after-paginate
   * bug in its second form: ask for twenty-four listings inside the radius,
   * discard the ones in other categories, and show four — with a truncation flag
   * that has stopped meaning anything and a pager that walks off the end of a
   * set nobody can count.
   */
  findWithin(search: ProximitySearch): Promise<ProximityPage | null>;
}
