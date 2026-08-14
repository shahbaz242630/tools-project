import { describe, expect, it } from 'vitest';
import {
  createRecordingLogger,
  createRecordingMetrics,
} from '@platform/observability/testing';
import { GeocoderUnavailableError } from './geocoder.js';
import { LocationService } from './location.service.js';
import { applyFuzzOffset, distanceMetres } from './fuzz.js';
import { FakeGeocoder } from './testing/fakes.js';

/**
 * The Search & Location service (slices 2.5b and 2.9b-ii).
 *
 * **This file exists for one method.** `locate` has been exercised through the
 * catalogue's integration tests since 2.5b, and that was proportionate while it
 * was the only entry point and its whole contract was "geocode, then displace".
 * `relocate` is different: what it must do is *not* draw an offset, and an
 * absence is not something an integration test observes. A `relocate` that
 * quietly ignored its argument and drew a fresh one would pass every test in the
 * catalogue — the listing would save, the point would be a legitimate
 * displacement, and the constraints would all hold.
 *
 * So the assertions here are about the arithmetic being exactly reproducible from
 * a stored offset, which is what §8.4.1 turns into a privacy property.
 */

/** The offset a listing is imagined to have had since it was created. */
const STORED = { bearingDegrees: 137, distanceMetres: 812 };

function service() {
  const geocoder = new FakeGeocoder().knows(FakeGeocoder.BS7_8AA);
  const logger = createRecordingLogger();
  const metrics = createRecordingMetrics();

  return {
    geocoder,
    logger,
    metrics,
    location: new LocationService(geocoder, logger.logger, metrics.metrics),
  };
}

describe('relocating against a stored offset', () => {
  it('returns the offset it was given rather than one of its own', async () => {
    const { location } = service();

    const placed = await location.relocate('BS7 8AA', STORED);

    expect(placed?.fuzzBearingDegrees).toBe(STORED.bearingDegrees);
    expect(placed?.fuzzDistanceMetres).toBe(STORED.distanceMetres);
  });

  it('publishes the point that offset actually produces', async () => {
    // Against `applyFuzzOffset` directly, so this fails if the service ever
    // returns a stored offset beside a point computed from a different one —
    // which is the shape a half-finished refactor would leave behind, and the
    // six values are only meaningful together.
    const { location } = service();

    const placed = await location.relocate('BS7 8AA', STORED);
    const expected = applyFuzzOffset(FakeGeocoder.BS7_8AA, STORED);

    expect(placed?.fuzzedLatitude).toBeCloseTo(expected.latitude, 9);
    expect(placed?.fuzzedLongitude).toBeCloseTo(expected.longitude, 9);
  });

  it('publishes the same point every single time', async () => {
    /*
     * **The privacy property, stated directly.** Ten saves of one address must
     * produce one published point. If each produced its own, every one of them
     * would be a legal 500–1000 m displacement and their mean would be the front
     * door — which is the averaging attack §8.4.1 and ADR 0032 exist to stop, and
     * which nothing else in this codebase would notice.
     */
    const { location } = service();

    const points = await Promise.all(
      Array.from({ length: 10 }, () => location.relocate('BS7 8AA', STORED)),
    );

    expect(new Set(points.map((point) => JSON.stringify(point))).size).toBe(1);
  });

  it('still carries the true point, so the caller stores both halves', async () => {
    const { location } = service();

    const placed = await location.relocate('BS7 8AA', STORED);

    expect(placed?.latitude).toBe(FakeGeocoder.BS7_8AA.latitude);
    expect(placed?.longitude).toBe(FakeGeocoder.BS7_8AA.longitude);
  });

  it('keeps the published point the stored distance away from the true one', async () => {
    // The offset came from storage rather than from `createFuzzOffset`, so the
    // floor is not guaranteed by the drawing — this is what checks the
    // arithmetic honours whatever it was handed.
    const { location } = service();

    const placed = await location.relocate('BS7 8AA', STORED);

    expect(
      distanceMetres(
        { latitude: placed?.latitude ?? 0, longitude: placed?.longitude ?? 0 },
        {
          latitude: placed?.fuzzedLatitude ?? 0,
          longitude: placed?.fuzzedLongitude ?? 0,
        },
      ),
    ).toBeCloseTo(STORED.distanceMetres, 0);
  });

  it('answers null for a postcode nothing recognises, without throwing', async () => {
    const { location } = service();

    await expect(location.relocate('ZZ99 9ZZ', STORED)).resolves.toBeNull();
  });

  it('answers null when the provider cannot be reached, without throwing', async () => {
    // The no-throw rule the port states: if this threw, every call site would
    // need a `try`, and the first that forgot would turn somebody else's outage
    // into a 500 on saving a listing.
    const { geocoder, location } = service();
    geocoder.failsOnce();

    await expect(location.relocate('BS7 8AA', STORED)).resolves.toBeNull();
  });

  it('logs the district and never the full postcode', async () => {
    // A full postcode in a log is an address in a log, retained as long as the
    // logs are. `locate` has followed this rule since 2.5b, and the two share one
    // geocoding step precisely so the second entry point cannot forget it.
    const { geocoder, logger, location } = service();
    geocoder.failsOnce();

    await location.relocate('BS7 8AA', STORED);

    const logged = JSON.stringify(logger.records);
    expect(logged).toContain('BS7');
    expect(logged).not.toContain('8AA');
  });
});

describe('locating for the first time', () => {
  it('draws its own offset, which is why the two methods are separate', async () => {
    /*
     * The contrast that makes `relocate` worth having. Twenty first-time places
     * of one postcode produce twenty different points — correct, because each is
     * a different listing whose coordinates have just come into existence, and
     * catastrophic if it ever happened twice to the *same* listing.
     */
    const { location } = service();

    const points = await Promise.all(
      Array.from({ length: 20 }, () => location.locate('BS7 8AA')),
    );
    const distinct = new Set(points.map((point) => JSON.stringify(point)));

    // Not `toBe(20)`: two independent draws can collide, and a test that forbids
    // it would fail on a coincidence rather than on a defect. What matters is
    // that they are not all one point.
    expect(distinct.size).toBeGreaterThan(1);
  });
});

/**
 * What the geocoder did, recorded (slice 3.1f).
 *
 * **These assertions are here rather than in a `geocode-quietly.test.ts`
 * because the write path is the half most likely to be forgotten.** The search
 * path has a db test watching it; saving a listing had nothing, and a metric
 * that covers only the read would make a geocoder outage look half as bad as it
 * is at the moment somebody cannot publish.
 *
 * The three outcomes are the three the caller deliberately cannot tell apart —
 * `locate` and `relocate` answer null for all of them — so this is the only
 * place the distinction is observable at all.
 */
describe('what the geocoder did', () => {
  it('records a successful geocode as found, with a duration', async () => {
    const { metrics, location } = service();

    await location.locate('BS7 8AA');

    expect(metrics.geocodes).toHaveLength(1);
    expect(metrics.geocodes[0]?.outcome).toBe('found');
    // Not a specific figure — a real clock is being read. That it is a
    // non-negative number is the whole claim, and it is `performance.now()`
    // rather than a wall clock so an NTP step cannot make it negative.
    expect(metrics.geocodes[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('separates a postcode nobody knows from a provider that is down', async () => {
    /*
     * **The distinction this slice exists for.** Both answer null, both serve an
     * empty page, and until now both looked identical from outside — so our own
     * provider being down was indistinguishable from a quiet area. One label
     * apart is the difference between "there is nothing near you" and "wake
     * somebody up".
     */
    const { geocoder, metrics, location } = service();

    await location.locate('ZZ99 9ZZ');
    geocoder.failsOnce();
    await location.locate('BS7 8AA');

    expect(metrics.geocodes.map((sample) => sample.outcome)).toEqual([
      'unknown',
      'unavailable',
    ]);
  });

  it('records the write path too, not only search', async () => {
    // `relocate` is an edit saving a listing. It reaches the same helper, which
    // is the point of the helper — but "it is the same function" is an argument,
    // and this is the test.
    const { metrics, location } = service();

    await location.relocate('BS7 8AA', STORED);

    expect(metrics.geocodes.map((sample) => sample.outcome)).toEqual(['found']);
  });

  it('does not let a broken metrics backend fail a geocode', async () => {
    /*
     * The rule the whole codebase follows and the one most easily undone here: a
     * diagnostic must not be able to fail the thing it is watching. This
     * function's entire contract is that geocoding cannot fail a request, and
     * recording must not become the one exception to it.
     */
    const geocoder = new FakeGeocoder().knows(FakeGeocoder.BS7_8AA);
    const logger = createRecordingLogger();
    const broken = {
      ...createRecordingMetrics().metrics,
      recordGeocode: () => {
        throw new Error('registry exploded');
      },
    };

    const location = new LocationService(geocoder, logger.logger, broken);

    await expect(location.locate('BS7 8AA')).resolves.not.toBeNull();
  });

  it('rethrows an unexpected error rather than filing it under unavailable', async () => {
    /*
     * A defect is not a provider outcome. Labelling one `unavailable` would
     * blame postcodes.io for our bug and quietly hide it in a metric somebody
     * has decided is somebody else's problem — so it is rethrown, becomes a 5xx,
     * and is counted there instead.
     */
    const logger = createRecordingLogger();
    const metrics = createRecordingMetrics();
    const broken = {
      locate: () => Promise.reject(new TypeError('undefined is not a function')),
    };

    const location = new LocationService(broken, logger.logger, metrics.metrics);

    await expect(location.locate('BS7 8AA')).rejects.toThrow(TypeError);
    expect(metrics.geocodes).toHaveLength(0);
  });

  it('still records the outcome when the provider raises its own error type', async () => {
    // Guards the `instanceof` above from being loosened into a catch-all, which
    // would swallow the defect case the previous test pins.
    const logger = createRecordingLogger();
    const metrics = createRecordingMetrics();
    const unreachable = {
      locate: () =>
        Promise.reject(new GeocoderUnavailableError('postcodes.io timed out')),
    };

    const location = new LocationService(unreachable, logger.logger, metrics.metrics);

    await expect(location.locate('BS7 8AA')).resolves.toBeNull();
    expect(metrics.geocodes.map((sample) => sample.outcome)).toEqual(['unavailable']);
  });
});
