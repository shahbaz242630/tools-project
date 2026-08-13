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

  it.each([
    ['a search box', 'searchbox'],
    ['a text input', 'textbox'],
  ])('does not offer %s, because search is Phase 3', (_case, role) => {
    // The design's hero is built around a search pill. Searching nothing would
    // be the largest dead control in the application (BRD §15).
    render(<Landing />);
    expect(screen.queryByRole(role)).not.toBeInTheDocument();
  });

  it.each(['Browse everything', 'Browse', 'Near you'])(
    'does not offer %s, because there is nothing to browse yet',
    (label) => {
      render(<Landing />);
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    },
  );

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
