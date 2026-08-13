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
   */
  findWithin(
    originPostcode: string,
    radiusMiles: SearchRadiusMiles,
    limit: number,
  ): Promise<ProximityPage | null>;
}
