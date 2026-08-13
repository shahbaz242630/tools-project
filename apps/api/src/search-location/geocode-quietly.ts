import type { Logger } from '@platform/observability';
import { GeocoderUnavailableError } from './geocoder.js';
import type { PostcodeGeocoder } from './geocoder.js';
import type { Point } from './fuzz.js';

/**
 * Geocoding that cannot fail a request — one null for both failures.
 *
 * **Extracted in slice 3.1a because a second caller appeared**, and it was the
 * kind of duplication that would have gone wrong quietly. `LocationService`
 * swallowed the provider's outage and logged the district; the search would have
 * had to do the same, and the version that got copied wrong is the one that logs
 * a whole postcode or lets a third party's downtime become a 500.
 *
 * **This is the only function in the module that returns a bare point**, which is
 * exactly what `LocationService`'s class docblock refuses to do. That refusal is
 * about the *boundary*: no caller outside Search & Location may obtain a true
 * coordinate without its displacement arriving in the same object. Inside the
 * module, the true point is the raw material — the fuzz is applied to it, and
 * the radius query measures from a searcher's own origin, which is not a
 * listing's location and is never stored.
 *
 * **Nothing here is exported beyond the module**, and nothing should be.
 */
export async function geocodeQuietly(
  geocoder: PostcodeGeocoder,
  logger: Logger,
  postcode: string,
): Promise<Point | null> {
  let located;
  try {
    located = await geocoder.locate(postcode);
  } catch (error) {
    if (!(error instanceof GeocoderUnavailableError)) throw error;

    // Warn rather than error: nothing was lost and the next attempt tries
    // again. Worth alerting on in aggregate — a geocoder down for a day means a
    // day of unlocatable listings and a day of searches that find nothing —
    // which is a job for the alerting `SECURITY.md` says we do not have yet.
    logger.warn('Could not geocode a postcode', {
      // The district only. A full postcode in a log is an address in a log.
      outwardCode: outwardCodeOf(postcode),
      reason: error.message,
    });
    return null;
  }

  if (located === null) {
    logger.info('No coordinates for this postcode', {
      outwardCode: outwardCodeOf(postcode),
    });
    return null;
  }

  return located;
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
