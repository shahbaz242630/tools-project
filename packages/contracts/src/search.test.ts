import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_RADIUS_MILES,
  SEARCH_RADII_MILES,
  parseListingSearchQuery,
  parsePublicListingSearchResults,
  publicListingSearchPath,
  widerRadius,
} from './search.js';

describe('the search radius vocabulary', () => {
  it('is BRD §8.4 five values, ascending', () => {
    expect(SEARCH_RADII_MILES).toEqual([5, 10, 20, 50, 100]);
  });

  it('defaults to the narrowest, because the marketplace is hyperlocal', () => {
    expect(DEFAULT_SEARCH_RADIUS_MILES).toBe(SEARCH_RADII_MILES[0]);
  });

  it('ladders up one step at a time, and stops at the top', () => {
    expect(widerRadius(5)).toBe(10);
    expect(widerRadius(50)).toBe(100);
    // The empty state hides its "search wider" offer here rather than looping.
    expect(widerRadius(100)).toBeNull();
  });
});

describe('parsing a search request', () => {
  it('accepts a postcode and one of the five radii', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '20' })).toEqual(
      { postcode: 'BS7 8AA', radiusMiles: 20 },
    );
  });

  it('reads the radius off a query string, where everything is a string', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '5' })).toEqual({
      postcode: 'BS7 8AA',
      radiusMiles: 5,
    });
  });

  it('defaults the radius when a pasted URL carries none', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA' }).radiusMiles).toBe(
      DEFAULT_SEARCH_RADIUS_MILES,
    );
  });

  /*
   * **The radius is a closed vocabulary and this is the test that says why.**
   * An arbitrary radius is an attacker's binary search: 1 mile, then 2, then 3,
   * and the step at which a listing appears is its distance from an origin they
   * chose. Rejecting 7 is not tidiness.
   */
  it('refuses a radius that is not on the list, however reasonable', () => {
    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '7' }),
    ).toThrow(/must be one of 5, 10, 20, 50, 100/);
  });

  it('refuses a radius above the largest, which is the one somebody would try', () => {
    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '500' }),
    ).toThrow(/must be one of/);
  });

  it('refuses a malformed postcode rather than searching from nowhere', () => {
    expect(() => parseListingSearchQuery({ postcode: 'not a postcode' })).toThrow(
      /valid UK postcode/,
    );
  });

  it('refuses a missing postcode', () => {
    expect(() => parseListingSearchQuery({})).toThrow();
  });
});

describe('the search path', () => {
  it('carries both parameters', () => {
    expect(publicListingSearchPath('BS7 8AA', 10)).toBe(
      '/public/listings?postcode=BS7%208AA&radiusMiles=10',
    );
  });

  it('round-trips through the parser, which is the only thing that matters', () => {
    const path = publicListingSearchPath('BS7 8AA', 50);
    const query = Object.fromEntries(
      path
        .slice(path.indexOf('?') + 1)
        .split('&')
        .map((pair) => pair.split('=').map(decodeURIComponent) as [string, string]),
    );

    expect(parseListingSearchQuery(query)).toEqual({
      postcode: 'BS7 8AA',
      radiusMiles: 50,
    });
  });
});

describe('parsing search results', () => {
  const RESULT = {
    id: '3f1a4e1e-6f1a-4a4b-9b3a-2a1a5f6c7d8e',
    title: 'Petrol lawn scarifier',
    categoryName: 'Outdoor and gardening',
    location: { outwardCode: 'BS7', town: 'Bristol' },
    inclusiveDailyPrice: {
      rate: { amount: 2_200, currency: 'GBP' },
      renterFee: { amount: 176, currency: 'GBP' },
      total: { amount: 2_376, currency: 'GBP' },
      minimumFeeApplied: false,
    },
    distance: { kind: 'under_a_mile' },
    ownerStatus: 'private_owner',
  };

  it('accepts a page of results', () => {
    const parsed = parsePublicListingSearchResults({
      results: [RESULT],
      truncated: false,
      radiusMiles: 5,
    });

    expect(parsed.results[0]?.distance).toEqual({ kind: 'under_a_mile' });
    expect(parsed.truncated).toBe(false);
    expect(parsed.radiusMiles).toBe(5);
  });

  it('accepts an approximate distance', () => {
    const parsed = parsePublicListingSearchResults({
      results: [{ ...RESULT, distance: { kind: 'approximate', miles: 3 } }],
      truncated: true,
      radiusMiles: 20,
    });

    expect(parsed.results[0]?.distance).toEqual({ kind: 'approximate', miles: 3 });
  });

  /*
   * §8.4.1 requires coarse buckets. A decimal on the wire would mean something
   * above the repository had reintroduced precision, which is the failure the
   * whole `DistanceBucket` type exists to make unrepresentable — so the parser
   * refuses it rather than rounding it away and hiding the bug.
   */
  it('refuses a fractional distance, which would mean an exact one leaked', () => {
    expect(() =>
      parsePublicListingSearchResults({
        results: [{ ...RESULT, distance: { kind: 'approximate', miles: 2.4 } }],
        truncated: false,
        radiusMiles: 5,
      }),
    ).toThrow();
  });

  it('refuses an unknown distance shape', () => {
    expect(() =>
      parsePublicListingSearchResults({
        results: [{ ...RESULT, distance: { kind: 'exact', metres: 812 } }],
        truncated: false,
        radiusMiles: 5,
      }),
    ).toThrow();
  });
});
