import { describe, expect, it } from 'vitest';
import { SEARCH_RADII_MILES } from '@platform/contracts';
import { BROWSE_PATH, browseHref, widerSearchHref } from './page-paths';

describe('where search lives', () => {
  it('is one path, so the nav and the form cannot disagree', () => {
    expect(BROWSE_PATH).toBe('/browse');
  });

  it('escapes the space in a postcode', () => {
    expect(browseHref('BS7 8AA', 5)).toBe('/browse?postcode=BS7%208AA&radiusMiles=5');
  });
});

describe('the empty state’s ladder', () => {
  it('offers the next radius up, keeping the postcode', () => {
    expect(widerSearchHref('BS7 8AA', 5)).toEqual({
      href: '/browse?postcode=BS7%208AA&radiusMiles=10',
      miles: 10,
    });
  });

  it('climbs every rung the BRD names', () => {
    // Read from the contract rather than written out, so a change to §8.4's
    // list moves the ladder rather than leaving it pointing at a dead radius.
    const climbed = SEARCH_RADII_MILES.slice(0, -1).map(
      (miles) => widerSearchHref('BS7 8AA', miles)?.miles,
    );

    expect(climbed).toEqual([...SEARCH_RADII_MILES].slice(1));
  });

  it('offers nothing at the top', () => {
    expect(widerSearchHref('BS7 8AA', 100)).toBeNull();
  });
});
