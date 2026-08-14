import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_PAGE } from '@platform/contracts';
import type {
  PublicListingSearchResults,
  PublicListingSummary,
} from '@platform/contracts';
import { BrowseResults } from './browse-results';

const SCARIFIER: PublicListingSummary = {
  id: '8fe74923-e424-421c-b5a2-590280af0fae',
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

const page = (
  over: Partial<PublicListingSearchResults> = {},
): PublicListingSearchResults => ({
  results: [SCARIFIER],
  truncated: false,
  radiusMiles: 5,
  page: 1,
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
    render(<BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />);

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
    render(<BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />);

    expect(screen.getByText('£23.76')).toBeInTheDocument();
    expect(screen.queryByText(/£22\.00/)).not.toBeInTheDocument();
  });

  it('shows the district and the town, and nothing finer (§8.4.1)', () => {
    render(<BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />);

    expect(screen.getByText('Bristol · BS7')).toBeInTheDocument();
  });

  it('shows a bucketed distance', () => {
    render(<BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />);

    expect(screen.getByText('Less than a mile away')).toBeInTheDocument();
  });

  it('never renders a decimal distance, whatever the bucket says', () => {
    render(
      <BrowseResults
        results={page({
          results: [{ ...SCARIFIER, distance: { kind: 'approximate', miles: 12 } }],
        })}
        postcode="BA1 1AA"
        radiusMiles={20}
      />,
    );

    expect(screen.getByText('About 12 miles away')).toBeInTheDocument();
  });

  it('carries the no-photo block, which is every card today', () => {
    // Media is slice 2.6 and blocked on the domain, so this is the normal state
    // rather than a fallback — the initial is hidden from assistive technology
    // because it is decoration, not the title read twice.
    const { container } = render(
      <BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />,
    );

    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('P');
  });

  it('counts what it found, in words that survive one result', () => {
    render(<BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />);
    expect(
      screen.getByRole('heading', { name: '1 tool near you' }),
    ).toBeInTheDocument();
  });

  it('offers the next page when there are more than fit', () => {
    render(
      <BrowseResults
        results={page({ truncated: true })}
        postcode="BS7 8AA"
        radiusMiles={5}
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
    render(<BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />);

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('discloses no address, coordinate or owner, whatever it is given', () => {
    // The 2.10 assertion applied to a collection: a results page is the version
    // of this data that gets scraped hardest, so the check is against everything
    // rendered rather than against named fields.
    const { container } = render(
      <BrowseResults results={page()} postcode="BS7 8AA" radiusMiles={5} />,
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
        postcode="BS7 8AA"
        radiusMiles={5}
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
        postcode="BS7 8AA"
        radiusMiles={5}
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
        postcode="BS7 8AA"
        radiusMiles={5}
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
        postcode="BS7 8AA"
        radiusMiles={5}
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
        postcode="BS7 8AA"
        radiusMiles={5}
      />,
    );

    expect(screen.queryByRole('link', { name: /Previous/ })).not.toBeInTheDocument();
  });

  it('offers no next on the last page', () => {
    render(
      <BrowseResults
        results={page({ page: 4, truncated: false })}
        postcode="BS7 8AA"
        radiusMiles={5}
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
        postcode="BS7 8AA"
        radiusMiles={5}
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
    render(<BrowseResults results={beyond} postcode="BS7 8AA" radiusMiles={5} />);

    expect(
      screen.queryByRole('link', { name: /Search within/ }),
    ).not.toBeInTheDocument();
  });

  it('offers the way back to the first page', () => {
    render(<BrowseResults results={beyond} postcode="BS7 8AA" radiusMiles={5} />);

    expect(
      screen.getByRole('link', { name: /Start again from the first page/ }),
    ).toHaveAttribute('href', '/browse?postcode=BS7%208AA&radiusMiles=5');
  });
});

describe('when a radius has nothing in it', () => {
  const nothing = page({ results: [] });

  it('says so with the radius that was searched', () => {
    render(<BrowseResults results={nothing} postcode="BS7 8AA" radiusMiles={5} />);

    expect(
      screen.getByRole('heading', { name: 'Nothing within 5 miles' }),
    ).toBeInTheDocument();
  });

  it('offers the next radius up, carrying the postcode with it', () => {
    render(<BrowseResults results={nothing} postcode="BS7 8AA" radiusMiles={5} />);

    expect(
      screen.getByRole('link', { name: 'Search within 10 miles' }),
    ).toHaveAttribute('href', '/browse?postcode=BS7%208AA&radiusMiles=10');
  });

  it('climbs the ladder one rung at a time', () => {
    render(<BrowseResults results={nothing} postcode="BS7 8AA" radiusMiles={20} />);

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
    render(<BrowseResults results={nothing} postcode="BS7 8AA" radiusMiles={100} />);

    expect(
      screen.queryByRole('link', { name: /Search within/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/nothing listed near you yet/)).toBeInTheDocument();
  });
});
