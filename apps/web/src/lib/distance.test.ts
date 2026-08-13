import { describe, expect, it } from 'vitest';
import { distanceLabel } from './distance';

describe('the distance a searcher reads', () => {
  it('calls anything under a mile near, rather than a number', () => {
    expect(distanceLabel({ kind: 'under_a_mile' })).toBe('Less than a mile away');
  });

  it('says "about" so nobody reads it as a measurement', () => {
    expect(distanceLabel({ kind: 'approximate', miles: 4 })).toBe('About 4 miles away');
  });

  it('gets the singular right at one mile', () => {
    expect(distanceLabel({ kind: 'approximate', miles: 1 })).toBe('About 1 mile away');
  });

  /*
   * **The §8.4.1 assertion, and the reason this file exists.** The bucket type
   * cannot hold a decimal, so this can only fail if somebody later swaps it for
   * a raw number — which is exactly the change that would look like an
   * improvement. Asserted across the whole range rather than on one value.
   */
  it('never renders a decimal point, at any distance', () => {
    for (let miles = 1; miles <= 100; miles += 1) {
      expect(distanceLabel({ kind: 'approximate', miles })).not.toContain('.');
    }
  });
});
