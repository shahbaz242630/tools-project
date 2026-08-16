import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_PAGE, SEARCH_RADII_MILES } from '@platform/contracts';
import type { ListingSearchQuery, SearchRadiusMiles } from '@platform/contracts';
import {
  BROWSE_PATH,
  browseHref,
  editListingPath,
  hirePath,
  nextSearchHref,
  ownerListingPath,
  previousSearchHref,
  widerSearchHref,
} from './page-paths';

/**
 * One search, with everything a test is not about left at its default.
 *
 * From slice 3.2a these builders take the whole query rather than a parameter
 * each — see `browseHref` for why — so a test about the pager should not have to
 * restate a postcode and a category to say what it means.
 */
const searchFor = (over: Partial<ListingSearchQuery> = {}): ListingSearchQuery => ({
  postcode: 'BS7 8AA',
  radiusMiles: 5,
  page: 1,
  category: null,
  keyword: null,
  ...over,
});

describe('where search lives', () => {
  it('is one path, so the nav and the form cannot disagree', () => {
    expect(BROWSE_PATH).toBe('/browse');
  });

  it('escapes the space in a postcode', () => {
    expect(browseHref(searchFor())).toBe('/browse?postcode=BS7%208AA&radiusMiles=5');
  });

  it('leaves the page off the first one, so no URL changed in slice 3.1d', () => {
    expect(browseHref(searchFor({ page: 1 }))).toBe(browseHref(searchFor()));
  });

  it('carries the page from the second on', () => {
    expect(browseHref(searchFor({ page: 2 }))).toBe(
      '/browse?postcode=BS7%208AA&radiusMiles=5&page=2',
    );
  });

  /*
   * **The same rule for the category, and it is the one that matters for
   * §8.17** (slice 3.2a): `?category=` returns exactly what the bare URL
   * returns, so minting it would create a duplicate of the canonical for every
   * unfiltered search on the one indexable collection page we have.
   */
  it('leaves an absent category out entirely', () => {
    expect(browseHref(searchFor({ category: null }))).not.toContain('category');
  });

  it('carries a category when there is one', () => {
    expect(browseHref(searchFor({ category: 'outdoor-gardening' }))).toBe(
      '/browse?postcode=BS7%208AA&radiusMiles=5&category=outdoor-gardening',
    );
  });

  it('escapes a category, for the reason it escapes a postcode', () => {
    // Not reachable through the contract's slug rules, which is the point: the
    // builder must not depend on its input having been validated elsewhere.
    expect(browseHref(searchFor({ category: 'a b' }))).toContain('category=a%20b');
  });
});

describe('where a listing lives', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('sends a stranger to the hire page and an owner to the management page', () => {
    // Two pages about one listing, and they are not the same page: one is
    // crawlable and shows a postal district, the other is `noindex` and shows a
    // street address. A helper that returned the wrong one would leak the second
    // to whoever followed the link.
    expect(hirePath(ID)).toBe(`/hire/${ID}`);
    expect(ownerListingPath(ID)).toBe(`/listings/${ID}`);
  });

  it('builds the edit form from the listing page, not by hand', () => {
    // The listing page concatenated `/edit` onto the *API* path. Deriving it
    // here means slice 2.12 moves both together or neither.
    expect(editListingPath(ID)).toBe(`${ownerListingPath(ID)}/edit`);
  });

  it('escapes the id, for the reason `hirePath` does', () => {
    // Ids are uuids today and will be slugs from 2.12. A builder must not
    // depend on its input having been validated somewhere else.
    expect(ownerListingPath('a b')).toBe('/listings/a%20b');
    expect(editListingPath('a b')).toBe('/listings/a%20b/edit');
  });
});

describe('the pager’s ends', () => {
  it('offers the next page when the server found more', () => {
    expect(nextSearchHref(searchFor(), true)).toEqual({
      href: '/browse?postcode=BS7%208AA&radiusMiles=5&page=2',
      page: 2,
    });
  });

  it('offers nothing when the server found no more', () => {
    // `truncated` is measured by probing for one row past the page, so this is
    // a fact rather than an inference from a full page.
    expect(nextSearchHref(searchFor(), false)).toBeNull();
  });

  /*
   * A "next" link on the last permitted page would point at a page the API
   * refuses with a 400 — BRD §15's dead control wearing a working link's
   * clothes. The boundary is decided here rather than at the call site.
   */
  it('offers nothing past the cap, however much more there is', () => {
    expect(nextSearchHref(searchFor({ page: MAX_SEARCH_PAGE }), true)).toBeNull();
  });

  it('steps back one page, and drops the parameter at the first', () => {
    expect(previousSearchHref(searchFor({ page: 3 }))?.page).toBe(2);
    expect(previousSearchHref(searchFor({ page: 2 }))?.href).toBe(
      '/browse?postcode=BS7%208AA&radiusMiles=5',
    );
  });

  it('offers nothing before the first page', () => {
    expect(previousSearchHref(searchFor({ page: 1 }))).toBeNull();
  });

  /*
   * **Both ends keep every filter**, which is the property the object-shaped
   * argument exists for. A pager that dropped the category would not break — it
   * would page through a *different search*, silently.
   */
  it('carries the category in both directions', () => {
    const filtered = searchFor({ page: 3, category: 'outdoor-gardening' });

    expect(nextSearchHref(filtered, true)?.href).toContain(
      'category=outdoor-gardening',
    );
    expect(previousSearchHref(filtered)?.href).toContain('category=outdoor-gardening');
  });
});

describe('the empty state’s ladder', () => {
  it('offers the next radius up, keeping the postcode', () => {
    expect(widerSearchHref(searchFor())).toEqual({
      href: '/browse?postcode=BS7%208AA&radiusMiles=10',
      miles: 10,
    });
  });

  it('climbs every rung the BRD names', () => {
    // Read from the contract rather than written out, so a change to §8.4's
    // list moves the ladder rather than leaving it pointing at a dead radius.
    const climbed = SEARCH_RADII_MILES.slice(0, -1).map(
      (miles: SearchRadiusMiles) =>
        widerSearchHref(searchFor({ radiusMiles: miles }))?.miles,
    );

    expect(climbed).toEqual([...SEARCH_RADII_MILES].slice(1));
  });

  it('offers nothing at the top', () => {
    expect(widerSearchHref(searchFor({ radiusMiles: 100 }))).toBeNull();
  });

  it('drops back to the first page when it widens', () => {
    // Widening changes which listings exist and how they are ordered, so
    // carrying page four across would land somebody in the middle of a set they
    // have never seen the start of.
    expect(widerSearchHref(searchFor({ page: 4 }))?.href).not.toContain('page');
  });

  /*
   * **But it keeps the category, which is the opposite treatment and the right
   * one** (slice 3.2a). Widening is the answer to "nothing near me"; dropping
   * the filter at the same moment would change two things at once and leave the
   * searcher unable to tell which produced the results. Dropping the filter is
   * its own offer, and it belongs to the empty state.
   */
  it('keeps the category when it widens', () => {
    expect(
      widerSearchHref(searchFor({ category: 'outdoor-gardening' }))?.href,
    ).toContain('category=outdoor-gardening');
  });
});
