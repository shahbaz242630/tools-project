import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_PAGE, SEARCH_PAGE_SIZE } from '@platform/contracts';
import type {
  ListingSearchQuery,
  PublicListingSearchResults,
  PublicListingSummary,
} from '@platform/contracts';
import { BrowseResults, isNarrowed } from './browse-results';

const SCARIFIER: PublicListingSummary = {
  id: '8fe74923-e424-421c-b5a2-590280af0fae',
  title: 'Petrol lawn scarifier',
  categoryName: 'Outdoor and gardening',
  location: { outwardCode: 'BS7', town: 'Bristol' },
  // No photograph, which stays the ordinary case after 2.6c: owners can upload
  // one now, and most listings will not have one for a long time.
  thumbnail: null,
  inclusiveDailyPrice: {
    rate: { amount: 2_200, currency: 'GBP' },
    renterFee: { amount: 176, currency: 'GBP' },
    total: { amount: 2_376, currency: 'GBP' },
    minimumFeeApplied: false,
  },
  distance: { kind: 'under_a_mile' },
  ownerStatus: 'private_owner',
};

const page = (
  over: Partial<PublicListingSearchResults> = {},
): PublicListingSearchResults => ({
  results: [SCARIFIER],
  truncated: false,
  radiusMiles: 5,
  page: 1,
  category: null,
  keyword: null,
  dates: null,
  // The default is the ordinary case — we placed the origin and ran the query —
  // so every test below reads as being about what the search *found*. The one
  // group that overrides it is the one about not having searched at all.
  originStatus: 'placed',
  ...over,
});

/**
 * The search these results answer.
 *
 * From slice 3.2a this component takes the whole query rather than a prop per
 * parameter — see `BrowseResults` for why — so the helper supplies the defaults
 * and a test names only what it is about.
 */
const searchFor = (over: Partial<ListingSearchQuery> = {}): ListingSearchQuery => ({
  postcode: 'BS7 8AA',
  radiusMiles: 5,
  page: 1,
  category: null,
  keyword: null,
  dates: null,
  ...over,
});

/** A full page of distinct listings, for the tests that are about paging. */
const full = (count: number): PublicListingSummary[] =>
  Array.from({ length: count }, (_unused, index) => ({
    ...SCARIFIER,
    id: `8fe74923-e424-421c-b5a2-590280af0f${String(index).padStart(2, '0')}`,
    title: `Scarifier ${String(index)}`,
  }));

describe('a page of results', () => {
  it('renders a card per listing, linking to the listing itself', () => {
    render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('link', { name: /Petrol lawn scarifier/ })).toHaveAttribute(
      'href',
      `/hire/${SCARIFIER.id}`,
    );
  });

  it('shows the inclusive total and never the bare rate (§3.4.4)', () => {
    /*
     * §3.4.4 names listing **cards** specifically, and drip pricing is a legal
     * exposure rather than a UX preference. The owner's £22.00 must not appear:
     * the number on a card is the number a renter pays.
     */
    render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByText('£23.76')).toBeInTheDocument();
    expect(screen.queryByText(/£22\.00/)).not.toBeInTheDocument();
  });

  it('shows the district and the town, and nothing finer (§8.4.1)', () => {
    render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByText('Bristol · BS7')).toBeInTheDocument();
  });

  it('shows a bucketed distance', () => {
    render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByText('Less than a mile away')).toBeInTheDocument();
  });

  it('never renders a decimal distance, whatever the bucket says', () => {
    render(
      <BrowseResults
        results={page({
          results: [{ ...SCARIFIER, distance: { kind: 'approximate', miles: 12 } }],
        })}
        search={searchFor({ postcode: 'BA1 1AA', radiusMiles: 20 })}
        categoryName={null}
      />,
    );

    expect(screen.getByText('About 12 miles away')).toBeInTheDocument();
  });

  it('carries the no-photo block, which is every card today', () => {
    // Media is slice 2.6 and blocked on the domain, so this is the normal state
    // rather than a fallback — the initial is hidden from assistive technology
    // because it is decoration, not the title read twice.
    const { container } = render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('P');
  });

  it('counts what it found, in words that survive one result', () => {
    render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );
    expect(
      screen.getByRole('heading', { name: '1 tool near you' }),
    ).toBeInTheDocument();
  });

  it('offers the next page when there are more than fit', () => {
    render(
      <BrowseResults
        results={page({ truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('link', { name: /Next 24 tools/ })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&page=2',
    );
  });

  it('offers no pager at all on a single complete page', () => {
    // Neither end exists, so the whole nav goes rather than rendering two
    // disabled controls — a greyed-out link that does nothing is a dead control
    // in a different coat (BRD §15).
    render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('discloses no address, coordinate or owner, whatever it is given', () => {
    // The 2.10 assertion applied to a collection: a results page is the version
    // of this data that gets scraped hardest, so the check is against everything
    // rendered rather than against named fields.
    const { container } = render(
      <BrowseResults
        results={page()}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );
    const html = container.innerHTML;

    expect(html).not.toContain('8AA');
    expect(html).not.toMatch(/lat|lon|coordinate/i);
    expect(html).not.toContain('ownerId');
  });
});

describe('paging between results (slice 3.1d)', () => {
  it('says which results these are once there is more than one page', () => {
    render(
      <BrowseResults
        results={page({ results: full(24), page: 2, truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    // 25–48, counted from `resultsToSkip` — the same function the API skips by,
    // so a heading cannot describe a page other than the one underneath it.
    expect(
      screen.getByRole('heading', { name: 'Tools 25–48 near you' }),
    ).toBeInTheDocument();
  });

  it('keeps the plain count on the first page', () => {
    render(
      <BrowseResults
        results={page({ results: full(24), truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('heading', { name: '24 tools near you' }),
    ).toBeInTheDocument();
  });

  it('offers the way back from the second page onwards', () => {
    render(
      <BrowseResults
        results={page({ page: 3, truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('link', { name: /Previous 24 tools/ })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&page=2',
    );
  });

  it('drops the page parameter when stepping back to the first', () => {
    // One search, one URL: `?page=1` is a duplicate of the canonical rather than
    // the canonical, which is what slice 2.12 would otherwise have to untangle.
    render(
      <BrowseResults
        results={page({ page: 2, truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('link', { name: /Previous 24 tools/ })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5',
    );
  });

  it('offers no previous on the first page', () => {
    render(
      <BrowseResults
        results={page({ truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.queryByRole('link', { name: /Previous/ })).not.toBeInTheDocument();
  });

  it('offers no next on the last page', () => {
    render(
      <BrowseResults
        results={page({ page: 4, truncated: false })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.queryByRole('link', { name: /Next/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Previous/ })).toBeInTheDocument();
  });

  /*
   * **The cap, said out loud.** `MAX_SEARCH_PAGE` stops an uncapped offset
   * costing a query per page for as deep as somebody cares to go — but a page
   * that simply stopped, with results on screen and no control, reads as a bug.
   */
  it('stops at the cap and says why, rather than linking to a page the API refuses', () => {
    render(
      <BrowseResults
        results={page({ page: MAX_SEARCH_PAGE, truncated: true })}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(screen.queryByRole('link', { name: /Next/ })).not.toBeInTheDocument();
    expect(screen.getByText(/as far as we page/)).toBeInTheDocument();
  });
});

describe('past the last page', () => {
  const beyond = page({ results: [], page: 4 });

  /*
   * **Two different empty pages.** Nothing on page one means nothing is near
   * them, and the answer is a wider radius. Nothing on page four means they have
   * walked off the end of a set that *did* have results — offering a wider
   * radius there would tell somebody their area is empty straight after showing
   * them what is in it.
   */
  it('does not offer a wider radius, because the area was not empty', () => {
    render(
      <BrowseResults
        results={beyond}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(
      screen.queryByRole('link', { name: /Search within/ }),
    ).not.toBeInTheDocument();
  });

  it('offers the way back to the first page', () => {
    render(
      <BrowseResults
        results={beyond}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: /Start again from the first page/ }),
    ).toHaveAttribute('href', '/browse?postcode=BS7%208AA&radiusMiles=5');
  });
});

/**
 * Carrying the category filter (slice 3.2a).
 *
 * **Every link this component builds is a place the filter can be dropped**, and
 * dropping it does not fail — the searcher simply gets results from categories
 * they excluded, with nothing on screen or in a log saying so. That is why the
 * builders take the whole query, and this is the assertion that the plumbing
 * actually holds.
 */
describe('carrying a category through the links', () => {
  const filtered = (over: Partial<PublicListingSearchResults> = {}) =>
    page({ category: 'outdoor-gardening', ...over });

  it('keeps the filter on the next page', () => {
    render(
      <BrowseResults
        results={filtered({ truncated: true })}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('link', { name: /Next 24 tools/ })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&category=outdoor-gardening&page=2',
    );
  });

  it('keeps the filter on the previous page', () => {
    render(
      <BrowseResults
        results={filtered({ page: 3, truncated: true })}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('link', { name: /Previous 24 tools/ })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&category=outdoor-gardening&page=2',
    );
  });

  /*
   * **Widening the radius keeps the category**, which is the one that could
   * reasonably have gone either way. It is the answer to "nothing near me", so
   * silently dropping the filter at the same moment would answer a question the
   * searcher did not ask — and they would have no way to tell which of the two
   * changes produced the results.
   */
  it('keeps the filter when offering a wider radius', () => {
    render(
      <BrowseResults
        results={filtered({ results: [] })}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Search within 10 miles' }),
    ).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=10&category=outdoor-gardening',
    );
  });

  it('keeps the filter when offering the way back from past the end', () => {
    render(
      <BrowseResults
        results={filtered({ results: [], page: 4 })}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: /Start again from the first page/ }),
    ).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&category=outdoor-gardening',
    );
  });

  /*
   * **And an unfiltered search mints no `category=` at all.** One search, one
   * URL — the same rule that keeps `?page=1` out of the canonical, and the half
   * of §8.17's duplicate-content question this slice must not make worse.
   */
  it('writes no category parameter when there is no filter', () => {
    const { container } = render(
      <BrowseResults
        results={page({ truncated: true })}
        search={searchFor()}
        categoryName={null}
      />,
    );

    expect(container.innerHTML).not.toContain('category=');
  });
});

/**
 * §8.4's *"category alternatives"* (slice 3.2b).
 *
 * The BRD requires an empty result to offer *"nearby radius expansion and
 * category alternatives"*. With a launch catalogue of one category, a list of
 * other categories is a list of nothing — so the alternative that exists is the
 * same search without the narrowing.
 */
describe('when a filtered radius has nothing in it', () => {
  const filteredEmpty = (over: Partial<PublicListingSearchResults> = {}) =>
    page({ results: [], category: 'outdoor-gardening', ...over });

  it('names the category, so the reader can see they narrowed it', () => {
    render(
      <BrowseResults
        results={filteredEmpty()}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(
      screen.getByRole('heading', {
        name: 'Nothing in Outdoor and gardening within 5 miles',
      }),
    ).toBeInTheDocument();
  });

  /*
   * **The name is used exactly as typed.** The first version lower-cased it to
   * fit the sentence, which is fine for "Outdoor and gardening" and mangles
   * "DIY tools" — and a category name is configuration, so its capitalisation is
   * somebody's decision rather than ours to normalise. Found by looking at the
   * rendered page, not by a test.
   */
  it('does not re-case a name an administrator chose', () => {
    render(
      <BrowseResults
        results={filteredEmpty()}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName="DIY tools"
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Nothing in DIY tools within 5 miles' }),
    ).toBeInTheDocument();
  });

  /*
   * The category read failed, so the filter is applied but unnamed. It falls
   * back to wording that needs no name rather than rendering the slug — a slug
   * on screen is a URL segment shown to a person.
   */
  it('falls back to the plain wording when the name is unknown', () => {
    render(
      <BrowseResults
        results={filteredEmpty()}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Nothing within 5 miles' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/outdoor-gardening/)).not.toBeInTheDocument();
  });

  it('offers the same search without the filter', () => {
    render(
      <BrowseResults
        results={filteredEmpty()}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(screen.getByRole('link', { name: 'Search all categories' })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5',
    );
  });

  /*
   * **Dropping the filter is offered before widening the radius**, because
   * staying local is the product: a renter wants the thing near them more than
   * a different thing forty miles away.
   */
  it('offers dropping the filter before widening the radius', () => {
    const { container } = render(
      <BrowseResults
        results={filteredEmpty()}
        search={searchFor({ category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    const links = [...container.querySelectorAll('a')].map((a) => a.textContent);
    expect(links[0]).toBe('Search all categories');
    expect(links[1]).toBe('Search within 10 miles');
  });

  it('offers no such link when nothing was filtered', () => {
    render(
      <BrowseResults
        results={page({ results: [] })}
        search={searchFor()}
        categoryName={null}
      />,
    );

    expect(
      screen.queryByRole('link', { name: 'Search all categories' }),
    ).not.toBeInTheDocument();
  });

  /*
   * **The claim at the top of the ladder must not overreach**, and this is the
   * one place the filter changes a *statement* rather than a control. "There is
   * nothing listed near you yet" is about the whole catalogue; with a category
   * on, all we know is that this category is empty within a hundred miles.
   */
  it('does not claim the whole catalogue is empty at a hundred miles', () => {
    render(
      <BrowseResults
        results={filteredEmpty({ radiusMiles: 100 })}
        search={searchFor({ radiusMiles: 100, category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(screen.queryByText(/nothing listed near you yet/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Nothing matching your search is listed within a hundred miles/),
    ).toBeInTheDocument();
    // The way out is still offered — that is what makes the narrower claim safe.
    expect(
      screen.getByRole('link', { name: 'Search all categories' }),
    ).toBeInTheDocument();
  });

  it('still claims it when nothing was filtered', () => {
    render(
      <BrowseResults
        results={page({ results: [], radiusMiles: 100 })}
        search={searchFor({ radiusMiles: 100 })}
        categoryName={null}
      />,
    );

    expect(screen.getByText(/nothing listed near you yet/)).toBeInTheDocument();
  });
});

describe('when a radius has nothing in it', () => {
  const nothing = page({ results: [] });

  it('says so with the radius that was searched', () => {
    render(
      <BrowseResults
        results={nothing}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Nothing within 5 miles' }),
    ).toBeInTheDocument();
  });

  it('offers the next radius up, carrying the postcode with it', () => {
    render(
      <BrowseResults
        results={nothing}
        search={searchFor({ postcode: 'BS7 8AA', radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Search within 10 miles' }),
    ).toHaveAttribute('href', '/browse?postcode=BS7%208AA&radiusMiles=10');
  });

  it('climbs the ladder one rung at a time', () => {
    render(
      <BrowseResults
        results={page({ results: [], radiusMiles: 20 })}
        search={searchFor({ radiusMiles: 20 })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Search within 50 miles' }),
    ).toBeInTheDocument();
  });

  it('offers nothing wider at a hundred miles, rather than the same search again', () => {
    /*
     * The top of the ladder. A control that re-runs the identical search is
     * worse than no control — and the honest reading at a hundred miles is that
     * nobody near them has listed yet, which is a supply problem we own.
     */
    render(
      <BrowseResults
        results={page({ results: [], radiusMiles: 100 })}
        search={searchFor({ radiusMiles: 100 })}
        categoryName={null}
      />,
    );

    expect(
      screen.queryByRole('link', { name: /Search within/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/nothing listed near you yet/)).toBeInTheDocument();
  });
});

/**
 * When we could not place the origin at all.
 *
 * **The defect these tests were written against was confirmed in a browser on
 * staging**, and it is the reason `originStatus` exists. postcodes.io going down
 * arrives here as a 200 with no listings — the API is right to answer that way,
 * since the postcode was well formed and a third party's outage is not a 5xx of
 * ours — and every branch above this one then described an area nobody had
 * looked at. At a hundred miles the page said *"There is nothing listed near you
 * yet. We are just getting started"*: a claim about the entire catalogue, made
 * during an outage, with no alert rule to notice it and nothing in the response
 * a reader could have used to know better.
 *
 * The fixture is deliberately the worst case rather than a convenient one — a
 * hundred miles, no filter — because that is the exact combination that produced
 * the sentence.
 */
describe('when the origin could not be placed', () => {
  const unplaceable = page({ results: [], originStatus: 'unplaceable' });

  /**
   * **The test that fails without the fix.**
   *
   * With the old contract there was no `originStatus` to set, an outage and an
   * empty area were the same value, and this rendered the catalogue-is-empty
   * sentence. Asserting its *absence* is the half that has teeth: the honest
   * heading could be added while the dishonest claim went on being rendered
   * underneath it, and the page would look fixed.
   */
  it('never claims the catalogue is empty when it could not look', () => {
    render(
      <BrowseResults
        results={page({
          results: [],
          radiusMiles: 100,
          originStatus: 'unplaceable',
        })}
        search={searchFor({ radiusMiles: 100 })}
        categoryName={null}
      />,
    );

    expect(screen.queryByText(/nothing listed near you yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We are just getting started/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'We could not search from that postcode' }),
    ).toBeInTheDocument();
  });

  it('says outright that this is not a statement about the area', () => {
    // Somebody who reads the heading and nothing else can still walk away
    // thinking their area is empty, so the thing they must not conclude is
    // written down rather than left to be inferred from a missing count.
    render(
      <BrowseResults
        results={unplaceable}
        search={searchFor({ postcode: 'BS7 8ZZ' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByText(/this does not mean there is nothing near you/),
    ).toBeInTheDocument();
  });

  it('shows the postcode it could not place, as the searcher typed it', () => {
    // The API does not echo the postcode, so this comes from the request — and
    // showing it is what turns a generic apology into something actionable: a
    // typo is visible the moment it is quoted back.
    render(
      <BrowseResults
        results={unplaceable}
        search={searchFor({ postcode: 'BS7 8ZZ' })}
        categoryName={null}
      />,
    );

    expect(screen.getByText(/BS7 8ZZ/)).toBeInTheDocument();
  });

  it('offers both pieces of advice, because we do not know which applies', () => {
    /*
     * An unrecognised postcode and a geocoder that is down are collapsed into
     * one null by `ListingProximity` before Catalogue sees them, so the page
     * genuinely cannot tell. Offering only "check the postcode" would blame the
     * searcher for our outage; offering only "try again shortly" would leave
     * somebody retrying a postcode that will never resolve.
     */
    render(
      <BrowseResults results={unplaceable} search={searchFor()} categoryName={null} />,
    );

    expect(screen.getByText(/Check the postcode and try again/)).toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
  });

  it('offers no wider radius, which could only fail the same way', () => {
    // What failed is the origin, not the radius, so "Search within 10 miles"
    // would be a control that cannot work — a dead control by BRD §15's rule,
    // and one that implies the radius was the problem.
    render(
      <BrowseResults
        results={unplaceable}
        search={searchFor({ radiusMiles: 5 })}
        categoryName={null}
      />,
    );

    expect(
      screen.queryByRole('link', { name: /Search within/ }),
    ).not.toBeInTheDocument();
  });

  it('says the same thing when a category was filtered', () => {
    /*
     * The filter is irrelevant here and must not soften the message into
     * "nothing in this category" — that is still a claim about inventory, and
     * "Search all categories" would offer a search that fails identically.
     */
    render(
      <BrowseResults
        results={page({
          results: [],
          radiusMiles: 100,
          category: 'outdoor-gardening',
          originStatus: 'unplaceable',
        })}
        search={searchFor({ radiusMiles: 100, category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'We could not search from that postcode' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing matching your search is listed/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Search all categories' }),
    ).not.toBeInTheDocument();
  });

  it('outranks the past-the-last-page state, which is also a claim about results', () => {
    /*
     * A stale link to page two of a search whose origin no longer places would
     * otherwise render *"Nothing more to show — you have reached the end of the
     * results"*, which asserts there were results and that this person saw them.
     * Both are false. This is why the check sits above every branch rather than
     * inside the empty state.
     */
    render(
      <BrowseResults
        results={page({ results: [], page: 2, originStatus: 'unplaceable' })}
        search={searchFor({ page: 2 })}
        categoryName={null}
      />,
    );

    expect(
      screen.queryByText(/reached the end of the results/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'We could not search from that postcode' }),
    ).toBeInTheDocument();
  });
});

/**
 * When words narrowed a search to nothing (slice 3.3b).
 *
 * **The empty state is where a keyword changes what a page may *claim*, not
 * just what it offers**, which is why almost every keyword test in this file is
 * here rather than beside the results grid.
 */
describe('when words have nothing matching them', () => {
  const keyworded = (over: Partial<PublicListingSearchResults> = {}) =>
    page({ results: [], keyword: 'hedge trimmer', ...over });

  it('names the words in the heading, so nobody reads it as an empty area', () => {
    render(
      <BrowseResults
        results={keyworded()}
        search={searchFor({ keyword: 'hedge trimmer' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('heading', {
        name: 'Nothing matching “hedge trimmer” within 5 miles',
      }),
    ).toBeInTheDocument();
  });

  /*
   * **Both narrowings in one sentence, in the order they narrow.** Four
   * combinations come out of two optional filters, and the middle two are the
   * ones a nested ternary gets wrong — which is why the sentence is composed by
   * a named function rather than assembled inside the JSX.
   */
  it('names the category and the words together when both are on', () => {
    render(
      <BrowseResults
        results={keyworded({ category: 'outdoor-gardening' })}
        search={searchFor({ keyword: 'hedge trimmer', category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(
      screen.getByRole('heading', {
        name: 'Nothing in Outdoor and gardening matching “hedge trimmer” within 5 miles',
      }),
    ).toBeInTheDocument();
  });

  /*
   * **The reader's own text, unaltered.** A category name is somebody else's
   * configuration and must not be case-folded (3.2b); a keyword is the reader's
   * and must not be either — showing it back changed is how somebody comes to
   * doubt what they typed.
   */
  it('shows the words exactly as they were typed', () => {
    render(
      <BrowseResults
        results={keyworded({ keyword: 'SDS+ Drill' })}
        search={searchFor({ keyword: 'SDS+ Drill' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('heading', {
        name: 'Nothing matching “SDS+ Drill” within 5 miles',
      }),
    ).toBeInTheDocument();
  });

  it('offers the same search without the words', () => {
    render(
      <BrowseResults
        results={keyworded()}
        search={searchFor({ keyword: 'hedge trimmer' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Search without “hedge trimmer”' }),
    ).toHaveAttribute('href', '/browse?postcode=BS7%208AA&radiusMiles=5');
  });

  /*
   * **Narrowest constraint first**: drop the words, then the category, then
   * widen the radius. A phrase is anything at all — including a typo, or simply
   * not the word this owner used — where a category is one of a handful. The
   * radius stays last because staying local is the product.
   */
  it('offers dropping the words before dropping the category', () => {
    render(
      <BrowseResults
        results={keyworded({ category: 'outdoor-gardening' })}
        search={searchFor({ keyword: 'hedge trimmer', category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    const links = screen.getAllByRole('link').map((link) => link.textContent);

    expect(links[0]).toBe('Search without “hedge trimmer”');
    expect(links[1]).toBe('Search all categories');
  });

  /*
   * **Each offer removes exactly the constraint it names.** A link that quietly
   * dropped both would answer a question the reader did not ask, and it would
   * look like it worked.
   */
  it('keeps the category when dropping the words', () => {
    render(
      <BrowseResults
        results={keyworded({ category: 'outdoor-gardening' })}
        search={searchFor({ keyword: 'hedge trimmer', category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Search without “hedge trimmer”' }),
    ).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&category=outdoor-gardening',
    );
  });

  it('keeps the words when dropping the category', () => {
    render(
      <BrowseResults
        results={keyworded({ category: 'outdoor-gardening' })}
        search={searchFor({ keyword: 'hedge trimmer', category: 'outdoor-gardening' })}
        categoryName="Outdoor and gardening"
      />,
    );

    expect(screen.getByRole('link', { name: 'Search all categories' })).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&keyword=hedge%20trimmer',
    );
  });

  /*
   * **The widening link carries the words**, the treatment the category already
   * had: widening answers "nothing near me", and silently dropping the search
   * terms at the same time would answer a question nobody asked.
   */
  it('carries the words into a wider radius', () => {
    render(
      <BrowseResults
        results={keyworded()}
        search={searchFor({ keyword: 'hedge trimmer' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Search within 10 miles' }),
    ).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=10&keyword=hedge%20trimmer',
    );
  });

  /*
   * **The claim at a hundred miles must not overreach for a keyword either**,
   * and this is the generalisation rather than a second case beside the
   * category's: a keyword finding nothing is the *weakest* possible evidence
   * about a catalogue, because the words might simply not be the ones an owner
   * used to describe the thing.
   */
  it('does not claim the whole catalogue is empty at a hundred miles', () => {
    render(
      <BrowseResults
        results={keyworded({ radiusMiles: 100 })}
        search={searchFor({ radiusMiles: 100, keyword: 'hedge trimmer' })}
        categoryName={null}
      />,
    );

    expect(screen.queryByText(/nothing listed near you yet/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Nothing matching your search is listed within a hundred miles/),
    ).toBeInTheDocument();
    // The way out is still offered, which is what makes the narrower claim safe.
    expect(
      screen.getByRole('link', { name: 'Search without “hedge trimmer”' }),
    ).toBeInTheDocument();
  });

  /*
   * **The trimmed keyword from the response wins over the request**, which is
   * the one field where the two legitimately differ: the contract trims, so
   * somebody who typed trailing space has a request that does not describe the
   * search that ran. Every link on this page is built from the response's value.
   */
  it('shows the keyword the search actually ran with, not the one requested', () => {
    render(
      <BrowseResults
        results={keyworded({ keyword: 'hedge trimmer' })}
        search={searchFor({ keyword: '  hedge trimmer  ' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('heading', {
        name: 'Nothing matching “hedge trimmer” within 5 miles',
      }),
    ).toBeInTheDocument();
  });
});

/**
 * The keyword on a page that found something (slice 3.3b).
 *
 * Only the links matter here — the heading is a count, and says nothing about
 * how the results were narrowed.
 */
describe('carrying words through the links', () => {
  /*
   * **One result rather than a full page, and that is a fix rather than a
   * shortcut.** The first version rendered `full(SEARCH_PAGE_SIZE)` — twenty-four
   * complete cards — to assert a single `href`, copied from the paging tests
   * where the count is what the heading is about. Here it is not: `truncated`
   * is what makes the pager appear, and one card proves the link exactly as
   * well as twenty-four do. The waste made this the slowest render in the file
   * and it was timing out under a loaded parallel run — the same failure the
   * flake fix addressed, arriving through a test that simply did too much.
   */
  it('carries the keyword to the next page', () => {
    render(
      <BrowseResults
        results={page({ truncated: true, keyword: 'drill' })}
        search={searchFor({ keyword: 'drill' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: `Next ${String(SEARCH_PAGE_SIZE)} tools →` }),
    ).toHaveAttribute(
      'href',
      '/browse?postcode=BS7%208AA&radiusMiles=5&keyword=drill&page=2',
    );
  });

  it('carries the keyword back from the past-the-end state', () => {
    render(
      <BrowseResults
        results={page({ results: [], page: 4, keyword: 'drill' })}
        search={searchFor({ page: 4, keyword: 'drill' })}
        categoryName={null}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Start again from the first page' }),
    ).toHaveAttribute('href', '/browse?postcode=BS7%208AA&radiusMiles=5&keyword=drill');
  });
});

/**
 * The predicate behind the hundred-mile claim (slice 3.3b).
 *
 * Tested directly as well as through the page, because its whole purpose is to
 * be the one place a new filter has to be remembered — and a wrong answer here
 * is a false sentence about the catalogue rather than a broken page. A reader
 * adding the price filter should find this list failing them.
 */
describe('whether a search was narrowed', () => {
  it('is not narrowed by where or how far, which are the question itself', () => {
    expect(isNarrowed(searchFor({ postcode: 'BA1 1AA', radiusMiles: 100 }))).toBe(
      false,
    );
  });

  it('is not narrowed by the page, which is a position in the answer', () => {
    expect(isNarrowed(searchFor({ page: 4 }))).toBe(false);
  });

  it.each([
    ['a category', { category: 'outdoor-gardening' }],
    ['words', { keyword: 'hedge trimmer' }],
    ['both', { category: 'outdoor-gardening', keyword: 'hedge trimmer' }],
  ])('is narrowed by %s', (_name, over) => {
    expect(isNarrowed(searchFor(over))).toBe(true);
  });
});

describe('what a dated search says it found (slice 4.9)', () => {
  const DATES = { from: '2026-09-15', to: '2026-09-17' };

  it('says the tools are free then, not merely near you', () => {
    /*
     * **"1 tool near you" is false once the filter is on**, in the way that
     * matters: there were two near them and one was booked. A searcher reading
     * it concludes the area is thin and widens the radius, when what they should
     * change is the dates. The same class as the geocoder outage the Phase 0–3
     * audit found — a narrower question answered in a wider question's words.
     */
    render(
      <BrowseResults
        search={searchFor({ dates: DATES })}
        results={page({ dates: DATES })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      '1 tool free 15 Sept 2026 to 17 Sept 2026',
    );
  });

  it('still says "near you" when no dates were asked for', () => {
    // The undated page must read exactly as it did before this slice.
    render(<BrowseResults search={searchFor()} results={page()} categoryName={null} />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      '1 tool near you',
    );
  });

  it('names the dates when it found nothing', () => {
    // "Nothing within 20 miles" is a statement about the catalogue; "nothing
    // free on those dates" is a statement about three days. The first sends
    // somebody away, the second sends them to a different week.
    render(
      <BrowseResults
        search={searchFor({ dates: DATES })}
        results={page({ results: [], dates: DATES })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /free 15 Sept 2026 to 17 Sept 2026/,
    );
  });

  it('says a single day once rather than twice', () => {
    render(
      <BrowseResults
        search={searchFor({ dates: { from: '2026-09-15', to: '2026-09-15' } })}
        results={page({ dates: { from: '2026-09-15', to: '2026-09-15' } })}
        categoryName={null}
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      '1 tool free 15 Sept 2026',
    );
  });
});

/**
 * The card's photograph (slice 2.6c).
 *
 * **`thumbnail` is nullable and most cards will be null**, so both branches are
 * tested and the empty one first. The card is the busiest surface in the product
 * — a page of them — and it is the one place a broken image would be twenty
 * broken images.
 */
const PHOTOGRAPHED: PublicListingSummary = {
  ...SCARIFIER,
  thumbnail: {
    url: 'https://bucket.example/scarifier/thumbnail?signature=abc',
    width: 400,
    height: 300,
  },
};

describe('a card’s photograph', () => {
  it('falls back to the item’s initial when there is none', () => {
    render(<BrowseResults results={page()} categoryName={null} search={searchFor()} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(document.body.textContent).toContain('P');
  });

  it('shows the thumbnail when the projection carries one', () => {
    render(
      <BrowseResults
        results={page({ results: [PHOTOGRAPHED] })}
        categoryName={null}
        search={searchFor()}
      />,
    );

    const image = screen.getByRole('img');
    expect(image.getAttribute('src')).toContain('scarifier/thumbnail');
  });

  it('names the item in the alt text rather than saying “photo of”', () => {
    render(
      <BrowseResults
        results={page({ results: [PHOTOGRAPHED] })}
        categoryName={null}
        search={searchFor()}
      />,
    );

    expect(screen.getByAltText('Petrol lawn scarifier')).toBeTruthy();
  });

  it('loads lazily, because most cards are below the fold', () => {
    render(
      <BrowseResults
        results={page({ results: [PHOTOGRAPHED] })}
        categoryName={null}
        search={searchFor()}
      />,
    );

    expect(screen.getByRole('img').getAttribute('loading')).toBe('lazy');
  });

  it('carries intrinsic dimensions, so a grid does not reflow as bytes arrive', () => {
    render(
      <BrowseResults
        results={page({ results: [PHOTOGRAPHED] })}
        categoryName={null}
        search={searchFor()}
      />,
    );

    const image = screen.getByRole('img');
    expect(image.getAttribute('width')).toBe('400');
    expect(image.getAttribute('height')).toBe('300');
  });

  it('mixes photographed and unphotographed listings on one page', () => {
    // The realistic state for a long time, and the one that would look worst if
    // the two treatments had different footprints.
    render(
      <BrowseResults
        results={page({
          results: [
            PHOTOGRAPHED,
            // A distinct id: two cards sharing one is a React key collision, and
            // the warning it prints is the kind a passing suite hides.
            { ...SCARIFIER, id: '8fe74923-e424-421c-b5a2-590280af0fb0' },
          ],
        })}
        categoryName={null}
        search={searchFor()}
      />,
    );

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getAllByRole('link').length).toBeGreaterThanOrEqual(2);
  });
});
