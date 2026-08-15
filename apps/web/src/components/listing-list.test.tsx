import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OwnedListings, OwnerListingSummary } from '@platform/contracts';
import { ListingList } from './listing-list';
import type { ListingOutcome } from '../lib/listings';

/**
 * The owner's list of their own listings (slice 2.9a).
 *
 * **The distinction this file is really about is between an empty list and a
 * list that could not be read.** "You have not listed anything yet" is a claim
 * about somebody's account, and rendering it because the API timed out tells a
 * person their evening's work has gone. `ActivityList` was written around the
 * same rule and for the same reason.
 */

function row(over: Partial<OwnerListingSummary> = {}): OwnerListingSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Petrol lawn scarifier',
    categoryName: 'Outdoor and gardening',
    status: 'DRAFT',
    moderationState: 'APPROVED',
    isLocated: true,
    inclusiveDailyPrice: null,
    createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z',
    ...over,
  };
}

function loaded(page: Partial<OwnedListings>): ListingOutcome<OwnedListings> {
  return {
    kind: 'loaded',
    value: { listings: [row()], truncated: false, ...page },
  };
}

describe('when the listings load', () => {
  it('links each listing to its own page', () => {
    // The entire point of the slice. Before it, the only route back to a listing
    // was the redirect that follows saving one — so an owner who closed the tab
    // needed the UUID.
    render(<ListingList outcome={loaded({})} />);

    const link = screen.getByRole('link', { name: 'Petrol lawn scarifier' });
    expect(link.getAttribute('href')).toBe(
      '/listings/11111111-1111-4111-8111-111111111111',
    );
  });

  it('says who can see each listing, from both authorities', () => {
    render(
      <ListingList
        outcome={loaded({
          listings: [row({ status: 'PUBLISHED', moderationState: 'REJECTED' })],
        })}
      />,
    );

    // Not "Published", which is what a cell reading `status` alone would say
    // about a listing the platform is refusing to show (ADR 0041). The refusal
    // is the half the owner did not already know, so it is the half the cell
    // gives its few words to.
    expect(document.body.textContent).toContain('Refused — hidden');
    expect(document.body.textContent).not.toContain('Live');
  });

  it('flags a listing nobody searching nearby could find', () => {
    render(<ListingList outcome={loaded({ listings: [row({ isLocated: false })] })} />);

    expect(document.body.textContent).toContain('Not on the map yet');
  });

  it('says nothing about the map when the listing is on it', () => {
    // Only the exception is worth a line. A note on every row is one nobody
    // reads, which is the same rule the listing page applies to the two-person
    // lift.
    render(<ListingList outcome={loaded({ listings: [row({ isLocated: true })] })} />);

    expect(document.body.textContent).not.toContain('Not on the map yet');
  });

  it('shows the inclusive price and says the fees are in it', () => {
    render(
      <ListingList
        outcome={loaded({
          listings: [
            row({
              inclusiveDailyPrice: {
                rate: { amount: 1_500, currency: 'GBP' },
                renterFee: { amount: 120, currency: 'GBP' },
                total: { amount: 1_620, currency: 'GBP' },
                minimumFeeApplied: false,
              },
            }),
          ],
        })}
      />,
    );

    // §3.4.4 names listing cards specifically: the headline is the total, and
    // the bare rate is not on this projection at all.
    expect(document.body.textContent).toContain('£16.20');
    expect(document.body.textContent).toContain('fees included');
    expect(document.body.textContent).not.toContain('£15.00');
  });

  it('says a listing is unpriced rather than free', () => {
    render(<ListingList outcome={loaded({ listings: [row()] })} />);

    expect(document.body.textContent).toContain('Not priced');
    expect(document.body.textContent).not.toContain('£0.00');
  });

  it('says so when the list was cut', () => {
    render(<ListingList outcome={loaded({ truncated: true })} />);

    // ADR 0035's rule at the surface that reads it. A list that quietly stops is
    // one somebody takes for their whole record.
    expect(screen.getByRole('alert').textContent).toContain('not all of them');
  });

  it('says nothing about truncation when the list is whole', () => {
    render(<ListingList outcome={loaded({ truncated: false })} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('when there is nothing to show', () => {
  it('offers the thing the person came to do', () => {
    render(<ListingList outcome={loaded({ listings: [] })} />);

    expect(document.body.textContent).toContain('not listed anything yet');
    expect(
      screen.getByRole('link', { name: 'List an item' }).getAttribute('href'),
    ).toBe('/listings/new');
  });

  it('renders no table at all', () => {
    // An empty table with headings reads as a page that failed rather than an
    // account with nothing in it.
    render(<ListingList outcome={loaded({ listings: [] })} />);

    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('when the listings cannot be read', () => {
  it('never says the account is empty', () => {
    // The defect this file exists to prevent, asserted over every failure kind
    // rather than the one somebody thought of.
    const failures: ListingOutcome<OwnedListings>[] = [
      { kind: 'unreachable', reason: 'timed out' },
      { kind: 'malformed', reason: 'bad json' },
      { kind: 'forbidden' },
      { kind: 'not-found' },
      { kind: 'invalid', issues: ['nope'] },
      { kind: 'stale-category', reason: 'moved' },
    ];

    for (const outcome of failures) {
      const { unmount } = render(<ListingList outcome={outcome} />);

      expect(document.body.textContent).not.toContain('not listed anything yet');
      expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
      // The reassurance is load-bearing: somebody who cannot see their listings
      // needs to know the listings are still there.
      expect(screen.getByRole('alert').textContent).toContain(
        'Nothing has been changed',
      );
      unmount();
    }
  });

  it('sends somebody who is not signed in to sign in, rather than reporting a fault', () => {
    // The one failure a person can act on, so it gets its own sentence and a
    // link. Collapsing it into the generic message would leave somebody
    // retrying a page that will never load until they sign in.
    render(<ListingList outcome={{ kind: 'signed-out' }} />);

    expect(screen.getByRole('link', { name: 'sign in' }).getAttribute('href')).toBe(
      '/sign-in',
    );
    expect(document.body.textContent).not.toContain('could not be loaded');
  });

  it('does not claim a session expired when there may never have been one', () => {
    // The fact that is certainly true, then the expiry offered as a possible
    // cause rather than asserted. The old copy opened "Your session has
    // expired", which is a statement about a session nobody here can vouch for
    // — an unauthenticated request looks identical whether it once had one.
    render(<ListingList outcome={{ kind: 'signed-out' }} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('You are not signed in');
    expect(alert).toHaveTextContent('may have expired');
    // Asserted absent rather than merely unasserted, as in
    // `account/profile/actions.test.ts`.
    expect(alert.textContent).not.toMatch(/session has expired/i);
  });
});
