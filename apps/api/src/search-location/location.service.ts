import type { Logger, Metrics } from '@platform/observability';
import type { PostcodeGeocoder } from './geocoder.js';
import { geocodeQuietly } from './geocode-quietly.js';
import { applyFuzzOffset, createFuzzOffset } from './fuzz.js';
import type { FuzzOffset, Point } from './fuzz.js';

/**
 * A postcode resolved to a point, and to the deliberately wrong point that gets
 * published (BRD §8.4.1, ADR 0032).
 *
 * The six values travel together and are stored together, because a true point
 * with no offset is a listing whose exact position *is* its published one — the
 * failure §8.4.1 exists to prevent, arriving silently. The database refuses that
 * combination too (`location_is_geocoded_or_not`).
 */
export interface FuzzedLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly fuzzBearingDegrees: number;
  readonly fuzzDistanceMetres: number;
  readonly fuzzedLatitude: number;
  readonly fuzzedLongitude: number;
}

/**
 * The Search & Location application service.
 *
 * It holds one rule, and the rule is the module: **a point is never published
 * where it actually is.** Everything else here is arranging for that to happen
 * exactly once per listing.
 *
 * The fuzzing is done here rather than by the caller so that no module can
 * acquire a true coordinate without the displaced one arriving in the same
 * object. A caller that could ask for "just the coordinates" is a caller that
 * will eventually store them somewhere public.
 */
export class LocationService {
  constructor(
    private readonly geocoder: PostcodeGeocoder,
    private readonly logger: Logger,
    /**
     * Carried only to be handed to `geocodeQuietly` (slice 3.1f).
     *
     * **Required rather than optional**, for the reason every dependency in this
     * codebase is: an optional one is one a boot site forgets, and the failure
     * would be a write path that silently stopped being measured while the
     * search path kept reporting — which reads as "geocoding is fine" at exactly
     * the moment half of it is not.
     */
    private readonly metrics: Metrics,
  ) {}

  /**
   * Locate a postcode, **drawing a new fuzz offset** at the same moment.
   *
   * **Null means "not located", for either reason, and that is deliberate.** The
   * geocoder distinguishes an unknown postcode (permanent) from an unreachable
   * provider (transient), and this service logs which — but it does not make the
   * caller handle two failure paths that both end in the same place. §8.3 makes
   * a draft permissive, so a listing saves either way and reads as not located.
   *
   * **The error is swallowed here rather than by Catalogue**, and the direction
   * matters: if it propagated, every call site would need a `try` and the first
   * one that forgot would turn a provider outage into a 500 on saving a listing.
   * Swallowed here, forgetting is impossible.
   *
   * **Called once per listing, when its coordinates first exist — and `relocate`
   * below is what every later write must use instead.** §8.4.1 forbids
   * recomputing the offset, because a listing that publishes several points
   * around one true address discloses that address through their mean.
   *
   * Through slice 2.9b-i that rule was kept by there being no other write at all:
   * this method's whole safety argument was *"it is only reachable from a
   * write"*, and creation was the only write. **2.9b-ii made an edit able to
   * change a postcode**, so the argument no longer holds on its own and the two
   * cases are separated by name. The reason they are two methods rather than one
   * with an optional offset is that an optional argument is one a caller omits,
   * and omitting it here silently redraws — the single failure this module exists
   * to prevent, arriving with nothing to catch it.
   */
  async locate(postcode: string): Promise<FuzzedLocation | null> {
    const located = await this.geocode(postcode);
    if (located === null) return null;

    return fuzzedAt(located, createFuzzOffset());
  }

  /**
   * Locate a postcode **against an offset this listing already has** (slice
   * 2.9b-ii).
   *
   * The method an *edit* calls, and the reason it exists. A listing's
   * displacement is drawn once and stored, and every subsequent write reuses it
   * — including a write that moves the listing to an entirely different postcode.
   *
   * **Reusing an offset across a genuine address change is safe, and redrawing
   * one across an unchanged address is not.** That asymmetry is the whole rule
   * and it is worth stating because the instinct runs the other way. A constant
   * offset applied to two different true points discloses only the *difference*
   * between those points, which an attacker watching a listing move already has.
   * A fresh offset applied twice to the *same* true point discloses the point
   * itself: two samples halve the error, and enough of them converge on the front
   * door.
   *
   * Callers that have no stored offset — a listing whose postcode has never been
   * successfully geocoded — must call `locate` instead. That is a real case
   * rather than a defensive one: geocoding is best effort (2.5b), so a provider
   * outage leaves an address with no coordinates and no offset, and the next save
   * is genuinely the moment its coordinates first exist.
   */
  async relocate(postcode: string, offset: FuzzOffset): Promise<FuzzedLocation | null> {
    const located = await this.geocode(postcode);
    if (located === null) return null;

    return fuzzedAt(located, offset);
  }

  /**
   * The geocoding both entry points share: a true point, or null for either
   * failure.
   *
   * Private, and it returns a *bare* point — which is the one thing the rest of
   * this module refuses to hand out. It is safe here only because nothing can
   * call it from outside: both public methods apply an offset before returning,
   * so no caller can obtain a true coordinate without the displaced one arriving
   * in the same object. Widening this to `public` would remove the guarantee the
   * class docblock makes.
   *
   * **The body moved to `geocode-quietly.ts` in slice 3.1a**, when the radius
   * search became a second caller needing the same no-throw, log-the-district
   * behaviour. This method stays because the guarantee above is about *this
   * class*, and deleting it would invite the search's helper to be called from
   * here directly by whoever next adds a method.
   */
  private async geocode(postcode: string): Promise<Point | null> {
    return geocodeQuietly(this.geocoder, this.logger, this.metrics, postcode);
  }
}

/**
 * A true point and an offset, assembled into the six values that travel together.
 *
 * One function rather than the same object literal at both call sites, for the
 * reason `rateColumns` exists in the listing adapter: two paths writing the same
 * record differently is how the pair comes to disagree, and the disagreement here
 * would be a published point that is not the stored offset applied to the stored
 * coordinates.
 */
function fuzzedAt(located: Point, offset: FuzzOffset): FuzzedLocation {
  const fuzzed = applyFuzzOffset(located, offset);

  return {
    latitude: located.latitude,
    longitude: located.longitude,
    fuzzBearingDegrees: offset.bearingDegrees,
    fuzzDistanceMetres: offset.distanceMetres,
    fuzzedLatitude: fuzzed.latitude,
    fuzzedLongitude: fuzzed.longitude,
  };
}
