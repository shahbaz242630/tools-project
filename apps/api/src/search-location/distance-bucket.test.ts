import { describe, expect, it } from 'vitest';
import { bucketDistance, milesToMetres } from './distance-bucket.js';
import { MAXIMUM_FUZZ_METRES } from './fuzz.js';

describe('miles to metres', () => {
  it('uses the international mile', () => {
    expect(milesToMetres(1)).toBeCloseTo(1_609.344, 3);
  });

  it('converts the five radii BRD §8.4 names', () => {
    expect(milesToMetres(5)).toBeCloseTo(8_046.72, 2);
    expect(milesToMetres(100)).toBeCloseTo(160_934.4, 1);
  });
});

describe('bucketing a distance', () => {
  it('calls anything under a mile near, rather than "about 0 miles"', () => {
    expect(bucketDistance(0)).toEqual({ kind: 'under_a_mile' });
    expect(bucketDistance(400)).toEqual({ kind: 'under_a_mile' });
    expect(bucketDistance(1_609)).toEqual({ kind: 'under_a_mile' });
  });

  it('switches at exactly one mile', () => {
    expect(bucketDistance(milesToMetres(1))).toEqual({ kind: 'approximate', miles: 1 });
  });

  it('rounds to the nearest whole mile', () => {
    expect(bucketDistance(milesToMetres(3.4))).toEqual({
      kind: 'approximate',
      miles: 3,
    });
    expect(bucketDistance(milesToMetres(3.6))).toEqual({
      kind: 'approximate',
      miles: 4,
    });
  });

  /*
   * The schema refuses `miles: 0`, so the boundary has to produce at least 1.
   * A floor instead of a round would emit zero for 1.0–1.9 miles and the wire
   * check would start rejecting real results.
   */
  it('never emits zero miles', () => {
    for (const metres of [1_609.344, 1_700, 2_000, 2_413]) {
      const bucket = bucketDistance(metres);
      if (bucket.kind === 'approximate') expect(bucket.miles).toBeGreaterThanOrEqual(1);
    }
  });

  it('never emits a fraction, at any distance', () => {
    for (let metres = 0; metres <= milesToMetres(100); metres += 733) {
      const bucket = bucketDistance(metres);
      if (bucket.kind === 'approximate') {
        expect(Number.isInteger(bucket.miles)).toBe(true);
      }
    }
  });

  /*
   * **The bucket is not what protects the address — this test says so out
   * loud.** The whole fuzz range is smaller than one bucket, so two listings a
   * fuzz apart are usually indistinguishable here; but a mile is still a large
   * enough area to be worth probing, and what actually defends the true point is
   * that the measurement started from a displaced one (ADR 0032).
   */
  it('is coarser than the entire fuzz range, which is the honest reading', () => {
    expect(MAXIMUM_FUZZ_METRES).toBeLessThan(milesToMetres(1));
  });
});
