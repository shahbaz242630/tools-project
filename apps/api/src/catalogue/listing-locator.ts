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

/**
 * A listing's stored displacement, on its way back out to be reused (slice
 * 2.9b-ii).
 *
 * **The one location value Catalogue may hold that is not a coordinate**, and it
 * is allowed across this boundary precisely because it is not one. A bearing and
 * a distance disclose nothing on their own: they say a listing sits somewhere on
 * a circle around a point nobody has been told. It is the *pair* — offset and
 * true point — that is sensitive, and the true point never leaves the store.
 *
 * Declared here rather than imported from Search & Location's `fuzz.ts` for the
 * reason this whole file exists: Catalogue states what it needs and does not
 * import the module that answers (BRD §5.1). The two shapes are structurally
 * identical, which is what lets the composition root pass one straight through.
 */
export interface StoredFuzzOffset {
  /** Degrees clockwise from north. */
  readonly bearingDegrees: number;
  /** Metres. At least the §8.4.1 floor, which the database also enforces. */
  readonly distanceMetres: number;
}

export interface ListingLocator {
  /**
   * Where this postcode is, **with a newly drawn offset**, or null if it could
   * not be located — for any reason.
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
   *
   * **For a listing whose coordinates do not exist yet, and nothing else.** A
   * listing that already has an offset must go through `relocate`, or it
   * publishes a second point around the same address and the two of them
   * together give it away (§8.4.1).
   */
  locate(postcode: string): Promise<LocatedListingPoint | null>;

  /**
   * Where this postcode is, **displaced by an offset the listing already has**
   * (slice 2.9b-ii).
   *
   * What an edit calls. The offset is drawn once in a listing's life and reused
   * by every write after it, so that saving the same address twice publishes the
   * same point twice — the property §8.4.1 depends on and the one an ordinary
   * "geocode it again" implementation quietly destroys.
   *
   * Null on failure, with the same meaning and the same no-throw rule as
   * `locate`. A caller that gets null on an edit is holding an address it could
   * not place, which is a legitimate draft and — from the completeness rules —
   * not a legitimate published listing.
   */
  relocate(
    postcode: string,
    offset: StoredFuzzOffset,
  ): Promise<LocatedListingPoint | null>;
}
