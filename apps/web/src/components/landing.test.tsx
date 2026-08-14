import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Landing } from './landing';

describe('Landing', () => {
  it('says what the platform is', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Borrow better',
    );
  });

  it('says booking is not open yet, above the fold', () => {
    /*
     * Booking is Phase 4 and payments are Phase 5, so every verb in the
     * how-it-works section describes the product rather than something a visitor
     * can do. Without this line the page is a shopfront for a shop that cannot
     * sell anything — the same disclosure `public-listing.tsx` has carried since
     * slice 2.10, in the same words.
     */
    render(<Landing />);
    expect(screen.getByText(/Booking is not open yet/)).toBeInTheDocument();
  });

  it('offers the one thing a visitor can actually do', () => {
    render(<Landing />);
    const listing = screen.getAllByRole('link', { name: 'List a tool' });
    expect(listing.length).toBeGreaterThan(0);
    for (const link of listing) {
      expect(link).toHaveAttribute('href', '/listings/new');
    }
  });

  /*
   * **These four were absence tests until slice 3.1e**, saying the hero must not
   * offer a search box because search was Phase 3 and a box that searches
   * nothing is the largest dead control available (BRD §15). Search exists now,
   * so they are inverted rather than deleted — the record should show the rule
   * being satisfied, not relaxed.
   */
  it('offers the search the design draws, now that there is something behind it', () => {
    render(<Landing />);

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /where are you looking/i }),
    ).toBeInTheDocument();
  });

  it('searches through the same route and field names the search page uses', () => {
    // It is `BrowseSearch` itself rather than a copy. A second form is a second
    // place for `postcode` to drift into `location`, and that failure is an
    // empty results page rather than an error.
    render(<Landing />);
    const form = screen.getByRole('search');

    expect(form).toHaveAttribute('action', '/browse');
    expect(form).toHaveAttribute('method', 'get');
    expect(form.querySelector('[name="postcode"]')).not.toBeNull();
    expect(form.querySelector('[name="radiusMiles"]')).not.toBeNull();
  });

  it('asks once, not three times', () => {
    /*
     * The design draws a hero pill, a "Near you" grid and "Browse everything".
     * With the header already carrying *Browse*, wiring all of them puts three
     * routes to one page on one screen. The grid is the one that had to go
     * regardless — see below — and "Browse everything" is its escape hatch, so
     * it has no parent left.
     */
    render(<Landing />);

    expect(screen.getAllByRole('search')).toHaveLength(1);
    expect(screen.queryByText('Browse everything')).not.toBeInTheDocument();
  });

  it('never claims to know where the reader is', () => {
    /*
     * **The test that pins the decision, and the reason it is phrased against
     * the rendered page rather than against a function.** The design's "Near
     * you" grid is a search *result*, so filling it means sourcing a location
     * from somebody who has given us none — browser geolocation (which Chrome's
     * own Lighthouse audit fails a page for requesting on load, and which
     * collects a precise point to answer a postcode-grade question), IP
     * inference (a free Cloudflare header, and wrong often enough at five miles
     * to be worse than nothing), or a remembered postcode (storage on a device,
     * which engages PECR and is not covered by the strictly-necessary
     * exemption).
     *
     * So the hero asks. If somebody later fills this grid from a request header,
     * this test is what stops it arriving unnoticed.
     */
    render(<Landing />);

    // Not a bare text match: the lede legitimately says "from people near you",
    // which is a description of the product rather than a claim about the
    // reader. What must not exist is a *panel* asserting proximity, or listings
    // presented as though we knew.
    expect(
      screen.queryByRole('heading', { name: /near you|in your area|near me/i }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .queryAllByRole('link')
        .filter((link) => /\/hire\//.test(link.getAttribute('href') ?? '')),
    ).toHaveLength(0);
  });

  describe('what it claims about money', () => {
    /*
     * These are the assertions that matter most on this page. BRD §8.7.2
     * authorises a hold against the renter's own card at the collection window;
     * no customer money is ever held by us. The design's copy said "Deposits
     * held safely", "with a refundable deposit" and "your deposit comes back",
     * all three of which describe a service we deliberately do not provide — and
     * §8.15 is explicit that substance beats labels.
     */
    it('never claims we hold a deposit', () => {
      render(<Landing />);
      expect(document.body.textContent).not.toMatch(/deposits? (is |are )?held/i);
      expect(document.body.textContent).not.toMatch(/refundable deposit/i);
    });

    it('calls it a hold and says whose card it sits on', () => {
      render(<Landing />);
      expect(screen.getByText(/A hold, not a deposit/)).toBeInTheDocument();
      expect(document.body.textContent).toMatch(/renter’s own card/);
    });

    it('says the displayed price already includes our fee', () => {
      // §3.4.4: totals inclusive of mandatory fees, everywhere they appear.
      render(<Landing />);
      expect(document.body.textContent).toMatch(/already includes our fee/);
    });
  });

  it('gives the how-it-works section an id the nav can point at', () => {
    // D2 left "How it works" out of the header because it had nowhere to go.
    // This is the anchor that lets it be added as a one-line change.
    render(<Landing />);
    expect(screen.getByRole('heading', { name: 'How it works' })).toHaveAttribute(
      'id',
      'how-it-works',
    );
  });
});
