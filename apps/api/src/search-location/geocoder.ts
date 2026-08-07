/**
 * Turning a postcode into a point on the earth.
 *
 * **The Search & Location module opens here** (BRD §5.1: *"Postcodes,
 * coordinates, radius queries, ranking"*). Slice 2.5b builds the first two;
 * radius queries and ranking are Phase 3, and the directory is named for the
 * whole module rather than for what is in it today so that the radius query has
 * somewhere to land — and so the `no-raw-sql-outside-search` invariant, which
 * exempts paths containing `search`, already covers it when it does.
 *
 * It owns no listings and no booking state, which is the boundary §5.1 draws.
 * Catalogue asks it where a postcode is; it does not know what the answer is
 * for.
 */

/** A postcode resolved to a point. */
export interface GeocodedPostcode {
  /**
   * The postcode **as the provider knows it**, normalised.
   *
   * Returned rather than discarded because a provider may recognise a form we
   * would not, and storing the point beside a postcode nobody can reproduce is
   * how a location becomes unverifiable later.
   */
  readonly postcode: string;
  /**
   * Degrees, WGS 84 — the coordinate system BRD §4.2's `geography(Point,4326)`
   * names.
   *
   * **Floats, and that is correct here.** ADR 0002 bans floating point for
   * *money*, because pence are whole and a rounding error is somebody's money.
   * A coordinate is a genuinely continuous quantity with no exact unit, and the
   * nearest integer degree is 111 km wide. Do not "fix" these into integers on
   * the strength of the money rule.
   */
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Raised when the geocoder could not be asked.
 *
 * **Distinct from a null return, and the distinction is the point.** Null means
 * the provider answered and does not recognise the postcode — a permanent fact
 * about that postcode, which retrying will not change. This means the question
 * never got an answer: a timeout, a network failure, a 500, a body we cannot
 * read. That is transient, and the caller may reasonably try again later.
 *
 * Collapsing the two would make a provider outage look like every postcode in
 * the country suddenly becoming invalid, which is the kind of thing that gets
 * shown to a user as "check your postcode".
 */
export class GeocoderUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GeocoderUnavailableError';
    this.cause = cause;
  }
}

export interface PostcodeGeocoder {
  /**
   * Where this postcode is, or null if the provider does not recognise it.
   *
   * Throws `GeocoderUnavailableError` when the provider could not be reached or
   * answered with something unreadable.
   *
   * **Implementations must not throw for an unknown postcode.** A postcode that
   * passed our own format check and is still unknown is an ordinary event — new
   * postcodes are issued continuously and the provider's data is a snapshot.
   */
  locate(postcode: string): Promise<GeocodedPostcode | null>;
}
