import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_PAGE, SEARCH_RADII_MILES } from '@platform/contracts';
import {
  BROWSE_PATH,
  browseHref,
  nextSearchHref,
  previousSearchHref,
  widerSearchHref,
} from './page-paths';

describe('where search lives', () => {
  it('is one path, so the nav and the form cannot disagree', () => {
    expect(BROWSE_PATH).toBe('/browse');
  });

  it('escapes the space in a postcode', () => {
    expect(browseHref('BS7 8AA', 5)).toBe('/browse?postcode=BS7%208AA&radiusMiles=5');
  });

  it('leaves the page off the first one, so no URL changed in slice 3.1d', () => {
    expect(browseHref('BS7 8AA', 5, 1)).toBe(browseHref('BS7 8AA', 5));
  });

  it('carries the page from the second on', () => {
    expect(browseHref('BS7 8AA', 5, 2)).toBe(
      '/browse?postcode=BS7%208AA&radiusMiles=5&page=2',
    );
  });
});

describe('the pager’s ends', () => {
  it('offers the next page when the server found more', () => {
    expect(nextSearchHref('BS7 8AA', 5, 1, true)).toEqual({
      href: '/browse?postcode=BS7%208AA&radiusMiles=5&page=2',
      page: 2,
    });
  });

  it('offers nothing when the server found no more', () => {
    // `truncated` is measured by probing for one row past the page, so this is
    // a fact rather than an inference from a full page.
    expect(nextSearchHref('BS7 8AA', 5, 1, false)).toBeNull();
  });

  /*
   * A "next" link on the last permitted page would point at a page the API
   * refuses with a 400 — BRD §15's dead control wearing a working link's
   * clothes. The boundary is decided here rather than at the call site.
   */
  it('offers nothing past the cap, however much more there is', () => {
    expect(nextSearchHref('BS7 8AA', 5, MAX_SEARCH_PAGE, true)).toBeNull();
  });

  it('steps back one page, and drops the parameter at the first', () => {
    expect(previousSearchHref('BS7 8AA', 5, 3)?.page).toBe(2);
    expect(previousSearchHref('BS7 8AA', 5, 2)?.href).toBe(
      '/browse?postcode=BS7%208AA&radiusMiles=5',
    );
  });

  it('offers nothing before the first page', () => {
    expect(previousSearchHref('BS7 8AA', 5, 1)).toBeNull();
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

  it('drops back to the first page when it widens', () => {
    // Widening changes which listings exist and how they are ordered, so
    // carrying page four across would land somebody in the middle of a set they
    // have never seen the start of.
    expect(widerSearchHref('BS7 8AA', 5)?.href).not.toContain('page');
  });
});
