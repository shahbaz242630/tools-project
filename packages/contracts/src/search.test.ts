import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_RADIUS_MILES,
  FIRST_SEARCH_PAGE,
  MAX_SEARCH_KEYWORD_LENGTH,
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
      {
        postcode: 'BS7 8AA',
        radiusMiles: 20,
        page: FIRST_SEARCH_PAGE,
        category: null,
        keyword: null,
        dates: null,
      },
    );
  });

  it('reads the radius off a query string, where everything is a string', () => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', radiusMiles: '5' })).toEqual({
      postcode: 'BS7 8AA',
      radiusMiles: 5,
      page: FIRST_SEARCH_PAGE,
      category: null,
      keyword: null,
      dates: null,
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
      keyword: null,
      dates: null,
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
      keyword: null,
      dates: null,
    });
  });

  /*
   * **The same "one search, one URL" rule for the keyword** (slice 3.3a). An
   * empty box is the ordinary state of the search field, so a `keyword=` that
   * got minted on every unkeyworded search would double the URL space of the one
   * page we let a crawler index.
   */
  it('leaves an absent keyword out entirely', () => {
    expect(publicListingSearchPath(searchFor({ keyword: null }))).not.toContain(
      'keyword',
    );
  });

  it('carries a keyword when there is one, encoded', () => {
    expect(publicListingSearchPath(searchFor({ keyword: 'hedge trimmer' }))).toBe(
      '/public/listings?postcode=BS7%208AA&radiusMiles=10&keyword=hedge%20trimmer',
    );
  });

  /*
   * The URL a searcher would actually copy out of the address bar with every
   * filter on at once — worth one test, because each parameter is only ever
   * exercised on its own above and the failure of getting the order or the
   * separators wrong is a URL that parses to a different search.
   */
  it('round-trips every parameter at once', () => {
    const path = publicListingSearchPath(
      searchFor({
        radiusMiles: 50,
        page: 4,
        category: 'outdoor-gardening',
        keyword: 'hedge trimmer',
        dates: { from: '2026-09-01', to: '2026-09-03' },
      }),
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
      keyword: 'hedge trimmer',
      dates: { from: '2026-09-01', to: '2026-09-03' },
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

describe('the keyword filter (slice 3.3a)', () => {
  /*
   * **The same three ways of saying "no keyword"**, and the same reason the
   * category filter needed them: Browse is a plain GET form, so an empty search
   * box submits `keyword=` on every unkeyworded search on the page.
   */
  it.each([
    ['absent', {}],
    ['empty', { keyword: '' }],
    ['whitespace', { keyword: '   ' }],
  ])('treats a %s keyword as no keyword', (_name, extra) => {
    expect(parseListingSearchQuery({ postcode: 'BS7 8AA', ...extra }).keyword).toBe(
      null,
    );
  });

  it('keeps the words somebody typed', () => {
    expect(
      parseListingSearchQuery({ postcode: 'BS7 8AA', keyword: 'hedge trimmer' })
        .keyword,
    ).toBe('hedge trimmer');
  });

  /*
   * **Trimmed rather than searched as typed.** Trailing space is what a phone
   * keyboard adds after a word, and leading space is what a paste brings with
   * it. More to the point, the trimmed value is what the response echoes, so the
   * page cannot display one thing while the database was asked another.
   */
  it('trims, so the echoed keyword is the one that ran', () => {
    expect(
      parseListingSearchQuery({ postcode: 'BS7 8AA', keyword: '  hedge trimmer  ' })
        .keyword,
    ).toBe('hedge trimmer');
  });

  /*
   * **Nothing is refused for its content**, which is the difference between this
   * filter and the category one and is worth pinning. A category slug names
   * something we either have or do not; a keyword is a question, and words we
   * hold no listing for are an ordinary empty result rather than a bad request.
   * Punctuation matters most: `websearch_to_tsquery` accepts all of it, and a
   * schema that rejected it here would refuse searches the database handles
   * perfectly well.
   */
  it.each(['3" drill bit', "O'Brien mower", 'hedge & trimmer', '!!!', 'Bad Slug'])(
    'accepts %s rather than lecturing somebody about syntax',
    (keyword) => {
      expect(parseListingSearchQuery({ postcode: 'BS7 8AA', keyword }).keyword).toBe(
        keyword,
      );
    },
  );

  /*
   * **Bounded, and this is the availability control rather than a form rule.**
   * This is the one public route answering with a collection, from an origin the
   * caller chooses, with nothing rate-limiting it — so no unbounded string from
   * a query parameter reaches the planner.
   */
  it('refuses a keyword longer than the bound', () => {
    expect(() =>
      parseListingSearchQuery({
        postcode: 'BS7 8AA',
        keyword: 'x'.repeat(MAX_SEARCH_KEYWORD_LENGTH + 1),
      }),
    ).toThrow(/characters or fewer/);
  });

  it('accepts one exactly at the bound', () => {
    expect(
      parseListingSearchQuery({
        postcode: 'BS7 8AA',
        keyword: 'x'.repeat(MAX_SEARCH_KEYWORD_LENGTH),
      }).keyword,
    ).toHaveLength(MAX_SEARCH_KEYWORD_LENGTH);
  });

  /*
   * The bound is applied to what will actually be searched, not to what arrived
   * — otherwise a padded paste is refused for a length no query would ever see.
   */
  it('measures the bound after trimming', () => {
    expect(
      parseListingSearchQuery({
        postcode: 'BS7 8AA',
        keyword: `  ${'x'.repeat(MAX_SEARCH_KEYWORD_LENGTH)}  `,
      }).keyword,
    ).toHaveLength(MAX_SEARCH_KEYWORD_LENGTH);
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
    // No photograph — the ordinary case, and the one the base fixture should
    // describe so a test wanting a thumbnail has to say so.
    thumbnail: null,
    ownerStatus: 'private_owner',
  };

  /**
   * A complete, valid response — the base each case below deviates from by one
   * field.
   *
   * **Written when `originStatus` was added, and it fixed something on the way
   * in.** Three of the refusal tests here built their fixture by hand and left
   * `page` out of it, so *"refuses a fractional distance"* was in fact passing on
   * the missing page and would have gone on passing with the distance rule
   * deleted. A refusal test that can be satisfied by the wrong field is a test
   * about nothing in particular; one deliberate deviation from a known-good base
   * is what makes it about what it says.
   */
  const RESULTS = {
    results: [RESULT],
    truncated: false,
    radiusMiles: 5,
    page: 1,
    category: null,
    dates: null,
    originStatus: 'placed',
  };

  it('accepts a page of results', () => {
    const parsed = parsePublicListingSearchResults(RESULTS);

    expect(parsed.results[0]?.distance).toEqual({ kind: 'under_a_mile' });
    expect(parsed.truncated).toBe(false);
    expect(parsed.radiusMiles).toBe(5);
    expect(parsed.page).toBe(1);
  });

  it('accepts an approximate distance', () => {
    const parsed = parsePublicListingSearchResults({
      ...RESULTS,
      results: [{ ...RESULT, distance: { kind: 'approximate', miles: 3 } }],
      truncated: true,
      radiusMiles: 20,
    });

    expect(parsed.results[0]?.distance).toEqual({ kind: 'approximate', miles: 3 });
  });

  it('carries which page it is, so the pager steps from a fact', () => {
    expect(
      parsePublicListingSearchResults({ ...RESULTS, truncated: true, page: 7 }).page,
    ).toBe(7);
  });

  /**
   * A valid response with one field taken out.
   *
   * **Removal rather than a hand-built partial**, so the two tests about a
   * missing field cannot drift from what a complete response looks like. A
   * hand-built one is how *"refuses a fractional distance"* came to be passing on
   * an absent `page`: the fixture went stale as the shape grew, and the test kept
   * reporting green about something it was no longer exercising.
   */
  const withoutTheField = (field: 'page' | 'originStatus'): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...RESULTS };
    if (field === 'page') delete copy.page;
    else delete copy.originStatus;
    return copy;
  };

  it('refuses a response with no page, which would leave the pager guessing', () => {
    expect(() => parsePublicListingSearchResults(withoutTheField('page'))).toThrow();
  });

  /*
   * The card's photograph (slice 2.6b-ii). Three properties, and the third is
   * the one worth a test: `null` is a *value* here rather than an absence, so a
   * response that simply leaves the field out is refused rather than read as
   * "no photograph". That is the same rule `originStatus` is given above, and
   * the reason is the same — a field the server forgot and a field the server
   * says is empty must not be the same thing on the wire.
   */
  it('accepts a card with a thumbnail', () => {
    const parsed = parsePublicListingSearchResults({
      ...RESULTS,
      results: [
        {
          ...RESULT,
          thumbnail: {
            url: 'https://account.eu.r2.cloudflarestorage.com/k?X-Amz-Signature=abc',
            width: 400,
            height: 300,
          },
        },
      ],
    });

    expect(parsed.results[0]?.thumbnail?.width).toBe(400);
  });

  it('accepts a card with no thumbnail, which is most of them', () => {
    expect(parsePublicListingSearchResults(RESULTS).results[0]?.thumbnail).toBeNull();
  });

  it('refuses a card with no thumbnail field, which is not the same as none', () => {
    // Removal from the complete fixture rather than a hand-built partial, which
    // is `withoutTheField` above's argument: a hand-built one goes stale as the
    // shape grows and keeps reporting green about something it stopped testing.
    const withoutThumbnail: Record<string, unknown> = { ...RESULT };
    delete withoutThumbnail.thumbnail;

    expect(() =>
      parsePublicListingSearchResults({ ...RESULTS, results: [withoutThumbnail] }),
    ).toThrow();
  });

  /*
   * A thumbnail is a URL, and `z.url()` is what says so. It matters because the
   * value is minted from the object store's credential and interpolated into an
   * `<img src>` — a bare object key reaching a page would be a broken image with
   * nothing in any log, and a `javascript:` string would be worse.
   */
  it('refuses a thumbnail whose url is not a url', () => {
    expect(() =>
      parsePublicListingSearchResults({
        ...RESULTS,
        results: [
          { ...RESULT, thumbnail: { url: 'listings/a/b.webp', width: 4, height: 3 } },
        ],
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
        ...RESULTS,
        results: [{ ...RESULT, distance: { kind: 'approximate', miles: 2.4 } }],
      }),
    ).toThrow();
  });

  it('refuses an unknown distance shape', () => {
    expect(() =>
      parsePublicListingSearchResults({
        ...RESULTS,
        results: [{ ...RESULT, distance: { kind: 'exact', metres: 812 } }],
      }),
    ).toThrow();
  });

  /**
   * Whether the origin was placed at all.
   *
   * **The field exists because an empty `results` was being read as a fact about
   * the world.** A postcodes.io outage was answered with a 200 and no listings,
   * and Browse rendered *"There is nothing listed near you yet"* — a claim about
   * the whole catalogue, made without a single query having run.
   */
  describe('whether the origin could be placed', () => {
    it('accepts a page that says the origin could not be placed', () => {
      const parsed = parsePublicListingSearchResults({
        ...RESULTS,
        results: [],
        originStatus: 'unplaceable',
      });

      expect(parsed.originStatus).toBe('unplaceable');
      expect(parsed.results).toEqual([]);
    });

    it('says a search that ran and found nothing is still a placed origin', () => {
      // The combination the whole field turns on: no results, and they mean
      // something. If this could not be expressed there would be no difference
      // left to carry.
      const parsed = parsePublicListingSearchResults({ ...RESULTS, results: [] });

      expect(parsed.originStatus).toBe('placed');
    });

    /**
     * **This is the test that fails without the fix**, at the contract layer.
     *
     * Before `originStatus` existed, a response with no statement about the
     * origin parsed cleanly and every reader assumed the search had run. Refused
     * rather than defaulted, and the direction of the default is the argument:
     * assuming `placed` is assuming we looked, which is exactly the assumption
     * that put *"we are just getting started"* in front of somebody during a
     * provider outage.
     */
    it('refuses a response that does not say whether the origin was placed', () => {
      expect(() =>
        parsePublicListingSearchResults(withoutTheField('originStatus')),
      ).toThrow();
    });

    /*
     * The vocabulary is closed, and it has to stay closed: BRD §17's zero-result
     * rate is computed from these outcomes, so a status a server can invent is a
     * bucket nobody is counting. A third value is a deliberate change here and a
     * compile error in every reader, which is the point.
     */
    it('refuses a status outside the closed vocabulary', () => {
      expect(() =>
        parsePublicListingSearchResults({ ...RESULTS, originStatus: 'searched' }),
      ).toThrow();
    });
  });
});

describe('the date filter (§8.4 as amended, slice 4.9)', () => {
  const base = { postcode: 'BS7 8AA' };

  it('takes a pair and gives back one value', () => {
    const parsed = parseListingSearchQuery({
      ...base,
      availableFrom: '2026-09-01',
      availableTo: '2026-09-03',
    });

    expect(parsed.dates).toEqual({ from: '2026-09-01', to: '2026-09-03' });
  });

  it('is absent when neither date was given', () => {
    expect(parseListingSearchQuery(base).dates).toBe(null);
  });

  it('treats an empty pair as absent, because a GET form submits every control', () => {
    // The same case `searchCategorySchema` swallows: an untouched pair of date
    // inputs sends `availableFrom=&availableTo=`, and refusing it would 400 the
    // most ordinary search on the page.
    expect(
      parseListingSearchQuery({ ...base, availableFrom: '', availableTo: '' }).dates,
    ).toBe(null);
  });

  it('refuses half a range rather than guessing the other end', () => {
    /*
     * **The reason the pair is one field.** Two independent nullable values would
     * make a half-range representable, and every layer downstream would have to
     * decide what it means — three places to decide it and two of them wrong.
     */
    expect(() =>
      parseListingSearchQuery({ ...base, availableFrom: '2026-09-01' }),
    ).toThrow();
    expect(() =>
      parseListingSearchQuery({ ...base, availableTo: '2026-09-03' }),
    ).toThrow();
  });

  it('refuses a range that ends before it starts', () => {
    expect(() =>
      parseListingSearchQuery({
        ...base,
        availableFrom: '2026-09-03',
        availableTo: '2026-09-01',
      }),
    ).toThrow();
  });

  it('accepts a single day, which is a legitimate hire', () => {
    const parsed = parseListingSearchQuery({
      ...base,
      availableFrom: '2026-09-01',
      availableTo: '2026-09-01',
    });

    expect(parsed.dates).toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  it('refuses a range longer than anybody may agree to anywhere', () => {
    /*
     * §8.5.3: a hire *capable of subsisting* beyond three months is regulated
     * consumer hire under the CCA 1974, so 88 days is the ceiling on the whole
     * platform. A longer search is asking for something no listing can answer,
     * and running it would return nothing — which reads as *there is nothing
     * near you* rather than as *nobody may hire anything for that long*.
     */
    expect(() =>
      parseListingSearchQuery({
        ...base,
        availableFrom: '2026-09-01',
        availableTo: '2026-12-01',
      }),
    ).toThrow();
  });

  it('accepts a range exactly at the ceiling', () => {
    // 88 days inclusive: the 1st plus 87.
    const parsed = parseListingSearchQuery({
      ...base,
      availableFrom: '2026-09-01',
      availableTo: '2026-11-27',
    });

    expect(parsed.dates).not.toBe(null);
  });

  it('refuses a date that is not a date', () => {
    // Validated by the same function that later converts it, so `2026-02-30`
    // cannot be accepted here and throw in the conversion.
    expect(() =>
      parseListingSearchQuery({
        ...base,
        availableFrom: '2026-02-30',
        availableTo: '2026-03-02',
      }),
    ).toThrow();
  });

  const aSearch = (over = {}) => ({
    postcode: 'BS7 8AA',
    radiusMiles: 10 as const,
    page: FIRST_SEARCH_PAGE,
    category: null,
    keyword: null,
    dates: null,
    ...over,
  });

  it('mints no date parameters for an undated search', () => {
    // One search, one URL — the rule `?page=1`, `?category=` and `?keyword=` all
    // follow, and what slice 2.12 needs for §8.17's canonicals.
    const path = publicListingSearchPath(aSearch());

    expect(path).not.toContain('availableFrom');
    expect(path).not.toContain('availableTo');
  });

  it('writes both parameters or neither, never one', () => {
    const path = publicListingSearchPath(
      aSearch({ dates: { from: '2026-09-01', to: '2026-09-03' } }),
    );

    expect(path).toContain('availableFrom=2026-09-01');
    expect(path).toContain('availableTo=2026-09-03');
  });
});
