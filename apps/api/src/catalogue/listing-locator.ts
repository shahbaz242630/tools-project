/**
 * What Catalogue needs to know about where a postcode is.
 *
 * **Stated by the consumer, answered by Search & Location** — the same shape as
 * `AccountLookup`, which Profiles states and Identity answers. Catalogue does
 * not own postcodes or coordinates (BRD §5.1 says so explicitly), and it does
 * not import that module: the composition root wires the two together, so
 * neither knows the other's internals.
 */

/**
 * A located postcode, with its published displacement already applied.
 *
 * **The true and fuzzed pairs arrive together and are stored together.** There
 * is deliberately no way to ask for one without the other: a true coordinate
 * with no offset would be a listing published at its owner's front door, and it
 * would be silent. The database refuses the combination as well
 * (`location_is_geocoded_or_not`), because a rule this consequential is worth
 * holding in both places.
 */
export interface LocatedListingPoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly fuzzBearingDegrees: number;
  readonly fuzzDistanceMetres: number;
  readonly fuzzedLatitude: number;
  readonly fuzzedLongitude: number;
}

export interface ListingLocator {
  /**
   * Where this postcode is, or **null if it could not be located — for any
   * reason**.
   *
   * One null rather than two outcomes on purpose. Whether the postcode is
   * unrecognised or the provider is down changes what gets logged and nothing
   * else: §8.3 makes a draft permissive, so the listing saves either way and
   * reads as "not located yet". Handing Catalogue two failure modes it would
   * treat identically is how one of them eventually gets handled wrongly.
   *
   * **Implementations must not throw for an unreachable provider.** If this
   * could throw, every call site would need a `try`, and the first that forgot
   * would turn a third party's outage into a 500 on saving a listing.
   */
  locate(postcode: string): Promise<LocatedListingPoint | null>;
}
