import type { GeocodeOutcome, Logger, Metrics } from '@platform/observability';
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
 *
 * **It is also where every geocoder call is counted** (slice 3.1f), for the same
 * reason the function exists: it is the one place both the write path and the
 * search path pass through, so there is no second call site to forget. The three
 * outcomes it distinguishes here and then collapses into one null are exactly
 * the three the metric keeps apart — which is the whole point, because
 * collapsing is right for the *caller* and left the difference recorded nowhere.
 */
export async function geocodeQuietly(
  geocoder: PostcodeGeocoder,
  logger: Logger,
  metrics: Metrics,
  postcode: string,
): Promise<Point | null> {
  /*
   * **`performance.now()`, not `Date.now()`**, and the distinction is not
   * pedantry: this measures an *interval*, and a wall clock can step backwards
   * under NTP correction, which would record a negative duration into a
   * histogram. §6.1's rule about storing UTC governs instants that are written
   * down; nothing here is written down.
   */
  const startedAt = performance.now();
  const record = (outcome: GeocodeOutcome): void => {
    /*
     * **A diagnostic must never fail the thing it is watching.** This function's
     * entire contract is that geocoding cannot fail a request, so a broken
     * metrics backend must not be the one exception to it. Silent for the
     * `MetricsHook`'s reason: logging here would fire on every geocode during a
     * metrics incident, turning a diagnostic problem into a log-volume one.
     */
    try {
      metrics.recordGeocode({ outcome, durationMs: performance.now() - startedAt });
    } catch {
      /* deliberately nothing */
    }
  };

  let located;
  try {
    located = await geocoder.locate(postcode);
  } catch (error) {
    /*
     * Anything else is a defect rather than a provider outcome, so it is
     * rethrown **and deliberately not recorded**. There is no honest label for
     * it — filing it under `unavailable` would blame the provider for our bug —
     * and it is not invisible: it fails the request, which the HTTP histogram
     * already counts as a 5xx. The cost is that this metric's `_count` means
     * "calls that ended in one of the three known ways", not "calls made".
     */
    if (!(error instanceof GeocoderUnavailableError)) throw error;

    // Warn rather than error: nothing was lost and the next attempt tries
    // again. Worth alerting on in aggregate — a geocoder down for a day means a
    // day of unlocatable listings and a day of searches that find nothing —
    // and from 3.1f `geocode_duration_seconds{outcome="unavailable"}` is the
    // series that alert will be written against, rather than a log grep.
    logger.warn('Could not geocode a postcode', {
      // The district only. A full postcode in a log is an address in a log.
      outwardCode: outwardCodeOf(postcode),
      reason: error.message,
    });
    record('unavailable');
    return null;
  }

  if (located === null) {
    logger.info('No coordinates for this postcode', {
      outwardCode: outwardCodeOf(postcode),
    });
    record('unknown');
    return null;
  }

  record('found');
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
