import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_RADIUS_MILES,
  FIRST_SEARCH_PAGE,
  MAX_SEARCH_PAGE,
  SEARCH_PAGE_SIZE,
  SEARCH_RADII_MILES,
  nextSearchPage,
  parseListingSearchQuery,
  parsePublicListingSearchResults,
  previousSearchPage,
  publicListingSearchPath,
  resultsToSkip,
  widerRadius,
} from './search.js';
import type { ListingSearchQuery } from './search.js';

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

describe('the search page vocabulary', () => {
  it('starts at one and stops at the cap', () => {
    expect(FIRST_SEARCH_PAGE).toBe(1);
    expect(MAX_SEARCH_PAGE).toBe(20);
  });

  it('skips a whole page for every page already passed', () => {
    expect(resultsToSkip(1)).toBe(0);
    expect(resultsToSkip(2)).toBe(SEARCH_PAGE_SIZE);
    expect(resultsToSkip(5)).toBe(4 * SEARCH_PAGE_SIZE);
  });

  /*
   * **The offset and the heading come from one function**, which is the whole
   * reason it exists: the API skips `resultsToSkip(page)` rows and the page
   * renders "Tools 25–48". Two expressions that must agree would agree by
   * accident, and the disagreement would be invisible — a heading mislabelling
   * results looks exactly like a correct one.
   */
  it('is what the heading counts from, so a page cannot mislabel itself', () => {
    expect(resultsToSkip(2) + 1).toBe(25);
  });

  it('ladders one page at a time and stops at the cap', () => {
    expect(nextSearchPage(1)).toBe(2);
    expect(nextSearchPage(MAX_SEARCH_PAGE - 1)).toBe(MAX_SEARCH_PAGE);
    // The pager hides "next" here rather than linking to a page the API refuses.
    expect(nextSearchPage(MAX_SEARCH_PAGE)).toBeNull();
  });

  it('steps back to the first page and no further', () => {
    expect(previousSearchPage(2)).toBe(1);
    expect(previousSearchPage(FIRST_SEARCH_PAGE)).toBeNull();
  });
});

describe('parsing a search request', () => {
  it('accepts a postcode and one of the five radii', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '20' })).toEqual(
      { postcode: 'BS7 8AA', radiusMiles: 20, page: FIRST_SEARCH_PAGE, category: null },
    );
  });

  it('reads the radius off a query string, where everything is a string', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '5' })).toEqual({
      postcode: 'BS7 8AA',
      radiusMiles: 5,
      page: FIRST_SEARCH_PAGE,
      category: null,
    });
  });

  it('reads the page off a query string too', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', page: '3' }).page).toBe(3);
  });

  it('defaults the page when a pasted URL carries none', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA' }).page).toBe(
      FIRST_SEARCH_PAGE,
    );
  });

  it('refuses page zero and a negative page', () => {
    expect(() => parseListingSearchQuery({ postcode: 'BS7 8AA', page: '0' })).toThrow(
      /must be 1 or more/,
    );
    expect(() => parseListingSearchQuery({ postcode: 'BS7 8AA', page: '-2' })).toThrow(
      /must be 1 or more/,
    );
  });

  it('refuses a fractional page', () => {
    expect(() => parseListingSearchQuery({ postcode: 'BS7 8AA', page: '1.5' })).toThrow(
      /whole number/,
    );
  });

  /*
   * **The message is the assertion, not the refusal.** Both of these were
   * already refused; what they said was *"Invalid input: expected number,
   * received NaN"*, which the Browse page renders to a person verbatim. Found
   * by reading the page rather than by a test, so the test is here now.
   */
  it('refuses a page that is not a number, in words a person can read', () => {
    expect(() => parseListingSearchQuery({ postcode: 'BS7 8AA', page: 'two' })).toThrow(
      /must be a whole number/,
    );
    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', page: 'two' }),
    ).not.toThrow(/NaN/);
  });

  it('says what a radius must be, rather than what zod expected', () => {
    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: 'abc' }),
    ).toThrow(/must be one of 5, 10, 20, 50, 100/);
    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: 'abc' }),
    ).not.toThrow(/NaN/);
  });

  /*
   * **The cap is an availability control, not a product limit.** Offset
   * pagination skips rows the database has already found, so an uncapped page
   * number is a caller choosing how much work we do — on the one public
   * collection route with no rate limiting in front of it. Refused rather than
   * clamped, for the reason a radius of 7 is refused.
   */
  it('refuses a page past the cap rather than clamping it into range', () => {
    expect(() =>
      parseListingSearchQuery({
        postcode: 'BS7 8AA',
        page: String(MAX_SEARCH_PAGE + 1),
      }),
    ).toThrow(/must be 20 or less/);

    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', page: '100000' }),
    ).toThrow(/must be 20 or less/);
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
  /**
   * A search with everything at its default but the two fields a test names.
   *
   * The builder takes the whole query from slice 3.2a — see
   * `ListingSearchQuery` for why — so a test that cares about the radius should
   * not have to restate the page and the category to say so.
   */
  function searchFor(overrides: Partial<ListingSearchQuery> = {}): ListingSearchQuery {
    return {
      postcode: 'BS7 8AA',
      radiusMiles: 10,
      page: FIRST_SEARCH_PAGE,
      category: null,
      ...overrides,
    };
  }

  it('carries both parameters', () => {
    expect(publicListingSearchPath(searchFor())).toBe(
      '/public/listings?postcode=BS7%208AA&radiusMiles=10',
    );
  });

  /*
   * **One search, one URL.** `?page=1` and the bare path return identical
   * results, so minting both is the duplicate-content problem slice 2.12 has to
   * answer for §8.17 — cheapest not to create it. It also means slice 3.1d
   * changed no URL that already existed.
   */
  it('leaves the page out of the first page, so the canonical URL is unchanged', () => {
    expect(publicListingSearchPath(searchFor({ page: FIRST_SEARCH_PAGE }))).toBe(
      publicListingSearchPath(searchFor()),
    );
    expect(publicListingSearchPath(searchFor({ page: 1 }))).not.toContain('page');
  });

  it('carries the page from the second on', () => {
    expect(publicListingSearchPath(searchFor({ page: 3 }))).toBe(
      '/public/listings?postcode=BS7%208AA&radiusMiles=10&page=3',
    );
  });

  /*
   * **The same rule for the category** (slice 3.2a), and it is the half that
   * would otherwise be easy to get wrong: `?category=` is accepted by the parser
   * and means "all", so a builder that always emitted the parameter would mint
   * a second URL for every unfiltered search — §8.17's duplicate-content problem
   * arriving through a URL builder rather than through a form.
   */
  it('leaves an absent category out entirely', () => {
    expect(publicListingSearchPath(searchFor({ category: null }))).not.toContain(
      'category',
    );
  });

  it('carries a category when there is one', () => {
    expect(publicListingSearchPath(searchFor({ category: 'outdoor-gardening' }))).toBe(
      '/public/listings?postcode=BS7%208AA&radiusMiles=10&category=outdoor-gardening',
    );
  });

  it('round-trips through the parser, which is the only thing that matters', () => {
    const path = publicListingSearchPath(
      searchFor({ radiusMiles: 50, page: 4, category: 'outdoor-gardening' }),
    );
    const query = Object.fromEntries(
      path
        .slice(path.indexOf('?') + 1)
        .split('&')
        .map((pair) => pair.split('=').map(decodeURIComponent) as [string, string]),
    );

    expect(parseListingSearchQuery(query)).toEqual({
      postcode: 'BS7 8AA',
      radiusMiles: 50,
      page: 4,
      category: 'outdoor-gardening',
    });
  });
});

describe('the category filter (slice 3.2a)', () => {
  /*
   * **All three ways of saying "every category" mean the same thing**, and the
   * middle one is the case that matters: a plain GET form always submits every
   * named control, so choosing "All categories" sends `category=`. A schema that
   * refused it would 400 the most ordinary search on the page.
   */
  it.each([
    ['absent', {}],
    ['empty', { category: '' }],
    ['whitespace', { category: '   ' }],
  ])('treats a %s category as every category', (_name, extra) => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', ...extra }).category).toBe(
      null,
    );
  });

  it('keeps a well-formed slug', () => {
    expect(
      parseListingSearchQuery({ postcode: 'BS7 8AA', category: 'outdoor-gardening' })
        .category,
    ).toBe('outdoor-gardening');
  });

  /*
   * **Refused rather than ignored.** A slug that could never name a category is
   * a URL claiming something we do not serve — the same treatment as a radius of
   * seven — and answering it with an unfiltered search would show somebody every
   * category while their address bar names one.
   */
  it.each(['Outdoor Gardening', 'outdoor_gardening', '-leading', 'a', 'x'.repeat(65)])(
    'refuses %s',
    (slug) => {
      expect(() =>
        parseListingSearchQuery({ postcode: 'BS7 8AA', category: slug }),
      ).toThrow(/is not a category we have/);
    },
  );

  /*
   * **The searcher's message, not the administrator's** — slice 3.1d's lesson,
   * which was a zod internal message rendered to a person. `categorySlugSchema`
   * explains lowercase letters and single hyphens because somebody is typing
   * into a configuration form; nobody types this one.
   */
  it('never explains slug syntax to a searcher', () => {
    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', category: 'Bad Slug' }),
    ).toThrow(/is not a category we have/);

    expect(() =>
      parseListingSearchQuery({ postcode: 'BS7 8AA', category: 'Bad Slug' }),
    ).not.toThrow(/lowercase/);
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
      page: 1,
    });

    expect(parsed.results[0]?.distance).toEqual({ kind: 'under_a_mile' });
    expect(parsed.truncated).toBe(false);
    expect(parsed.radiusMiles).toBe(5);
    expect(parsed.page).toBe(1);
  });

  it('accepts an approximate distance', () => {
    const parsed = parsePublicListingSearchResults({
      results: [{ ...RESULT, distance: { kind: 'approximate', miles: 3 } }],
      truncated: true,
      radiusMiles: 20,
      page: 1,
    });

    expect(parsed.results[0]?.distance).toEqual({ kind: 'approximate', miles: 3 });
  });

  it('carries which page it is, so the pager steps from a fact', () => {
    expect(
      parsePublicListingSearchResults({
        results: [RESULT],
        truncated: true,
        radiusMiles: 5,
        page: 7,
      }).page,
    ).toBe(7);
  });

  it('refuses a response with no page, which would leave the pager guessing', () => {
    expect(() =>
      parsePublicListingSearchResults({
        results: [RESULT],
        truncated: false,
        radiusMiles: 5,
      }),
    ).toThrow();
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
