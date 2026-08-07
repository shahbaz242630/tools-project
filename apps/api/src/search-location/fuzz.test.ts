import { describe, expect, it } from 'vitest';
import {
  MAXIMUM_FUZZ_METRES,
  MINIMUM_FUZZ_METRES,
  applyFuzzOffset,
  createFuzzOffset,
  distanceMetres,
} from './fuzz.js';

/** Bristol, BS7 8AA — the real coordinates postcodes.io returns. */
const TRUE_POINT = { latitude: 51.470761, longitude: -2.593052 };

/**
 * Enough draws that a rule broken one time in a hundred cannot hide.
 *
 * The properties below are the normative ones from BRD §8.4.1, so a sampled
 * assertion is the right shape: there is no single input that proves "the
 * displacement is always at least 500 m".
 */
const SAMPLES = 500;

describe('drawing a fuzz offset', () => {
  it('never draws less than the 500 m floor BRD §8.4.1 sets', () => {
    for (let i = 0; i < SAMPLES; i++) {
      expect(createFuzzOffset().distanceMetres).toBeGreaterThanOrEqual(
        MINIMUM_FUZZ_METRES,
      );
    }
  });

  it('stays inside the ceiling, so the fuzz remains noise in a 5-mile radius', () => {
    for (let i = 0; i < SAMPLES; i++) {
      expect(createFuzzOffset().distanceMetres).toBeLessThanOrEqual(
        MAXIMUM_FUZZ_METRES,
      );
    }
  });

  it('reaches both ends of the range, so the bounds are inclusive as documented', () => {
    const drawn = new Set<number>();
    // `randomInt` excludes its upper bound, and the `+ 1` that makes the maximum
    // reachable is exactly the kind of thing that gets "tidied" away.
    for (let i = 0; i < 20_000; i++) drawn.add(createFuzzOffset().distanceMetres);

    expect(drawn.has(MINIMUM_FUZZ_METRES)).toBe(true);
    expect(drawn.has(MAXIMUM_FUZZ_METRES)).toBe(true);
  });

  it('uses the whole compass', () => {
    const bearings = new Set<number>();
    for (let i = 0; i < SAMPLES; i++) bearings.add(createFuzzOffset().bearingDegrees);

    // A displacement always northwards would put every true point due south of
    // its published one, which is a disclosure rather than a blur.
    expect(bearings.size).toBeGreaterThan(100);
    expect(Math.min(...bearings)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...bearings)).toBeLessThanOrEqual(359);
  });

  it('does not repeat itself', () => {
    const drawn = new Set(
      Array.from({ length: SAMPLES }, () => JSON.stringify(createFuzzOffset())),
    );

    // Two listings drawing the same offset is not a defect on its own, but a
    // *constant* offset would be: every published point would then be the same
    // translation of its true one, and solving one listing solves all of them.
    expect(drawn.size).toBeGreaterThan(SAMPLES / 2);
  });
});

describe('applying an offset', () => {
  it('moves the point by exactly the distance recorded', () => {
    for (let i = 0; i < SAMPLES; i++) {
      const offset = createFuzzOffset();
      const fuzzed = applyFuzzOffset(TRUE_POINT, offset);

      // Within a metre: the formula is spherical and the stored distance is a
      // whole number, so this asserts they agree rather than asserting a float.
      expect(distanceMetres(TRUE_POINT, fuzzed)).toBeCloseTo(offset.distanceMetres, 0);
    }
  });

  it('never lands within 500 m of the truth, whatever it drew', () => {
    for (let i = 0; i < SAMPLES; i++) {
      const fuzzed = applyFuzzOffset(TRUE_POINT, createFuzzOffset());

      // The property §8.4.1 actually states, measured on the output rather than
      // trusted from the input.
      expect(distanceMetres(TRUE_POINT, fuzzed)).toBeGreaterThanOrEqual(
        MINIMUM_FUZZ_METRES - 1,
      );
    }
  });

  it('is reproducible for a stored offset, which is what makes it storable', () => {
    const offset = { bearingDegrees: 137, distanceMetres: 742 };

    expect(applyFuzzOffset(TRUE_POINT, offset)).toEqual(
      applyFuzzOffset(TRUE_POINT, offset),
    );
  });

  it('goes north for 0° and south for 180°', () => {
    const north = applyFuzzOffset(TRUE_POINT, {
      bearingDegrees: 0,
      distanceMetres: 1_000,
    });
    const south = applyFuzzOffset(TRUE_POINT, {
      bearingDegrees: 180,
      distanceMetres: 1_000,
    });

    // A sign error in the formula would be invisible to every distance
    // assertion above, because distance has no direction.
    expect(north.latitude).toBeGreaterThan(TRUE_POINT.latitude);
    expect(south.latitude).toBeLessThan(TRUE_POINT.latitude);
    expect(north.longitude).toBeCloseTo(TRUE_POINT.longitude, 6);
  });

  it('goes east for 90° and west for 270°', () => {
    const east = applyFuzzOffset(TRUE_POINT, {
      bearingDegrees: 90,
      distanceMetres: 1_000,
    });
    const west = applyFuzzOffset(TRUE_POINT, {
      bearingDegrees: 270,
      distanceMetres: 1_000,
    });

    expect(east.longitude).toBeGreaterThan(TRUE_POINT.longitude);
    expect(west.longitude).toBeLessThan(TRUE_POINT.longitude);
    // Five places, not six, and the reason is real rather than a loosened
    // assertion: a great-circle path due east curves very slightly poleward, so
    // latitude moves by about 0.1 m over a kilometre at this latitude. A rhumb
    // line would hold it exactly, and this is deliberately not one.
    expect(east.latitude).toBeCloseTo(TRUE_POINT.latitude, 5);
  });

  it('keeps longitude in [-180, 180) across the antimeridian', () => {
    const fuzzed = applyFuzzOffset(
      { latitude: 0, longitude: 179.999 },
      { bearingDegrees: 90, distanceMetres: 1_000 },
    );

    // Irrelevant to a UK launch and free to get right — an unnormalised 180.008
    // is a longitude no map accepts.
    expect(fuzzed.longitude).toBeGreaterThanOrEqual(-180);
    expect(fuzzed.longitude).toBeLessThan(180);
  });
});

describe('measuring distance', () => {
  it('is zero for a point and itself', () => {
    expect(distanceMetres(TRUE_POINT, TRUE_POINT)).toBeCloseTo(0, 6);
  });

  it('agrees with a known distance', () => {
    // BS7 (north Bristol) to Bath city centre. Roughly 19 km as the crow flies —
    // further than the ~18 km usually quoted, because that figure is from
    // Bristol *centre* and this postcode is two miles north of it. Checked
    // against the flat-earth approximation by hand: 9.97 km north-south and
    // 16.2 km east-west at this latitude give 19.05 km.
    const bath = { latitude: 51.3811, longitude: -2.359 };

    expect(distanceMetres(TRUE_POINT, bath) / 1_000).toBeCloseTo(19.05, 1);
  });
});
