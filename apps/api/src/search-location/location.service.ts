import type { Logger } from '@platform/observability';
import { GeocoderUnavailableError } from './geocoder.js';
import type { PostcodeGeocoder } from './geocoder.js';
import { applyFuzzOffset, createFuzzOffset } from './fuzz.js';

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
  ) {}

  /**
   * Locate a postcode, drawing its fuzz offset at the same moment.
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
   * Called **once**, when a listing's coordinates first exist. §8.4.1 forbids
   * recomputing the offset per request, and the way to honour that is to have no
   * code path that recomputes one — this method is only reachable from a write.
   */
  async locate(postcode: string): Promise<FuzzedLocation | null> {
    let located;
    try {
      located = await this.geocoder.locate(postcode);
    } catch (error) {
      if (!(error instanceof GeocoderUnavailableError)) throw error;

      // Warn rather than error: the listing saved, nothing was lost, and the
      // next save tries again. It is worth alerting on in aggregate — a
      // geocoder down for a day means a day of unlocatable listings — which is
      // a job for the alerting `SECURITY.md` says we do not have yet.
      this.logger.warn('Could not geocode a listing postcode', {
        // The district only. A full postcode in a log is an address in a log.
        outwardCode: outwardCodeOf(postcode),
        reason: error.message,
      });
      return null;
    }

    if (located === null) {
      this.logger.info('No coordinates for this postcode', {
        outwardCode: outwardCodeOf(postcode),
      });
      return null;
    }

    const offset = createFuzzOffset();
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
}

/**
 * The publishable half of a postcode, for a log line.
 *
 * Deliberately not `Postcode.outwardCode` from `@platform/core`: that throws on
 * anything malformed, and a logging path must never be the thing that fails a
 * request. Whatever precedes the first space is enough for a log.
 */
function outwardCodeOf(postcode: string): string {
  return postcode.split(' ')[0] ?? '';
}
