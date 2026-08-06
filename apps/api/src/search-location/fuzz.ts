import { randomInt } from 'node:crypto';

/**
 * The location fuzz — BRD §8.4.1's trilateration defence (ADR 0032).
 *
 * §8.4.1 is **normative**: each listing gets a fixed random displacement of at
 * least 500 m, assigned once and never recomputed, and every public distance and
 * map marker uses the displaced point. Recomputing per request leaks the true
 * point through averaging — query enough times and the mean of many random
 * displacements converges on the truth.
 *
 * **Read ADR 0032 before changing anything in this file.** Two constants and one
 * function here look arbitrary and are not:
 *
 * - the offset is **drawn at random and stored**, never derived from the listing
 *   id, because a derived offset is invertible and a leaked key would yield
 *   every owner's home address with no database access at all;
 * - the distance is a **range**, not the flat 500 m the BRD's wording invites,
 *   because a fixed displacement puts the true point on a circle of exactly
 *   known radius and hands an attacker a ring instead of a disc.
 */

/** The BRD's floor. Normative — do not lower it. */
export const MINIMUM_FUZZ_METRES = 500;

/**
 * Ours. See ADR 0032: large enough that the true point lies in a band rather
 * than on a circle, small enough to stay noise inside the smallest radius BRD
 * §8.4 names (5 miles ≈ 8 km).
 */
export const MAXIMUM_FUZZ_METRES = 1_000;

/** Mean earth radius in metres, WGS 84. */
const EARTH_RADIUS_METRES = 6_371_008.8;

const DEGREES = Math.PI / 180;

/**
 * A displacement, as it is stored.
 *
 * Integers, so the stored value is exactly the value that was applied. Degrees
 * and metres are both quantities where a whole number is plenty: one degree of
 * bearing at 1 km is under 18 m, and metre precision on a deliberate blur is
 * already far finer than the blur.
 */
export interface FuzzOffset {
  /** Degrees clockwise from north, 0–359. */
  readonly bearingDegrees: number;
  /** Between `MINIMUM_FUZZ_METRES` and `MAXIMUM_FUZZ_METRES` inclusive. */
  readonly distanceMetres: number;
}

export interface Point {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Draw one offset. Called **once per listing**, when its coordinates first
 * exist, and the result is stored.
 *
 * `node:crypto`'s `randomInt` rather than `Math.random`: this is a privacy
 * control, and `Math.random` is a seeded PRNG whose output is predictable from
 * enough samples. An attacker able to predict the sequence could recover true
 * points from published ones for every listing created in the same run. That is
 * a narrow attack and the fix costs nothing.
 */
export function createFuzzOffset(): FuzzOffset {
  return {
    bearingDegrees: randomInt(0, 360),
    // `randomInt` excludes its upper bound; +1 makes the maximum reachable, so
    // the range is inclusive at both ends as the type above promises.
    distanceMetres: randomInt(MINIMUM_FUZZ_METRES, MAXIMUM_FUZZ_METRES + 1),
  };
}

/**
 * Move a point by an offset.
 *
 * The standard destination-point formula on a sphere. A sphere rather than the
 * WGS 84 ellipsoid because the error over a kilometre is a few metres, and a few
 * metres of error in a deliberate 500–1000 m blur is not error at all — it is
 * more blur.
 *
 * **Pure, and separate from `createFuzzOffset` on purpose.** Applying a *stored*
 * offset must be reproducible, which is what lets a test assert that the
 * displacement is what was recorded. Only the drawing is random.
 */
export function applyFuzzOffset(point: Point, offset: FuzzOffset): Point {
  const angular = offset.distanceMetres / EARTH_RADIUS_METRES;
  const bearing = offset.bearingDegrees * DEGREES;

  const latitude = point.latitude * DEGREES;
  const longitude = point.longitude * DEGREES;

  const sinLatitude =
    Math.sin(latitude) * Math.cos(angular) +
    Math.cos(latitude) * Math.sin(angular) * Math.cos(bearing);
  const fuzzedLatitude = Math.asin(sinLatitude);

  const fuzzedLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude),
      Math.cos(angular) - Math.sin(latitude) * sinLatitude,
    );

  return {
    latitude: fuzzedLatitude / DEGREES,
    // Normalised back into [-180, 180). A listing near the antimeridian would
    // otherwise be published at a longitude no map accepts — irrelevant for a UK
    // launch and free to get right, and "irrelevant for the launch category" is
    // how a latent bug gets written down as a decision. The double modulo is
    // because `%` in JavaScript keeps the sign of its left operand.
    longitude: normaliseLongitude(fuzzedLongitude / DEGREES),
  };
}

function normaliseLongitude(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * Great-circle distance in metres.
 *
 * Here rather than in a test helper because the tests that matter assert the
 * *displacement*, and a test that measured distance with its own formula would
 * be checking that two implementations agree rather than that the fuzz is at
 * least 500 m. Phase 3's bucketed distances will want this too.
 */
export function distanceMetres(from: Point, to: Point): number {
  const fromLatitude = from.latitude * DEGREES;
  const toLatitude = to.latitude * DEGREES;
  const deltaLatitude = (to.latitude - from.latitude) * DEGREES;
  const deltaLongitude = (to.longitude - from.longitude) * DEGREES;

  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(deltaLongitude / 2) ** 2;

  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}
