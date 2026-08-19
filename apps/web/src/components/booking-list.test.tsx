import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  BookingSummaries,
  BookingSummary,
  OwnerBookings,
  OwnerBookingSummary,
} from '@platform/contracts';
import { OwnerBookingList, RenterBookings } from './booking-list';
import type { ListingOutcome } from '../lib/listings';

/**
 * Both sides of a person's bookings (slice 4.8b).
 *
 * **The distinction this file is really about is between an empty list and a
 * list that could not be read** — `ListingList`'s rule, and it bites harder here.
 * "You have not asked to hire anything" rendered because the API timed out tells
 * somebody a confirmed hire has disappeared, and the thing they would do about
 * it is book it again.
 *
 * **The second subject is money.** A renter reads an inclusive total (§3.4.4) and
 * an owner reads their own charge with no payout — §3.4's commission arithmetic
 * is Phase 5, so a figure presented to an owner as what they receive would be a
 * false sentence about money. Three of those were found in the Phase 0–3 audit
 * and none of them failed a test, which is why they are pinned here.
 */

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

function hire(over: Partial<BookingSummary> = {}): BookingSummary {
  return {
    id: 'booking-1',
    listingId: '11111111-1111-4111-8111-111111111111',
    state: 'ACCEPTED',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    days: 3,
    itemTitle: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    total: gbp(5_832),
    requestExpiresAt: '2026-09-01T09:00:00.000Z',
    ...over,
  };
}

function letting(over: Partial<OwnerBookingSummary> = {}): OwnerBookingSummary {
  return {
    id: 'booking-2',
    listingId: '22222222-2222-4222-8222-222222222222',
    state: 'ACCEPTED',
    startDate: '2026-09-14',
    endDate: '2026-09-16',
    days: 3,
    itemTitle: 'SDS+ rotary hammer drill',
    itemCharge: gbp(5_400),
    requestExpiresAt: '2026-09-01T09:00:00.000Z',
    ...over,
  };
}

function hires(over: Partial<BookingSummaries> = {}): ListingOutcome<BookingSummaries> {
  return { kind: 'loaded', value: { bookings: [hire()], truncated: false, ...over } };
}

function lettings(over: Partial<OwnerBookings> = {}): ListingOutcome<OwnerBookings> {
  return {
    kind: 'loaded',
    value: { bookings: [letting()], truncated: false, ...over },
  };
}

describe('what a renter is hiring', () => {
  it('shows the booking, which was the whole hole in the product', () => {
    /*
     * Before this slice, 4.5b's confirmation was the only place a renter ever
     * saw a booking and a reload lost it. This is the first page that holds one.
     */
    render(<RenterBookings outcome={hires()} />);

    expect(screen.getByRole('heading', { name: 'Petrol hedge trimmer' })).toBeVisible();
    expect(screen.getByText('Confirmed')).toBeVisible();
  });

  it('links to the public listing page, not the API route', () => {
    // `page-paths.ts` exists because these were confused once already — a link
    // to `/public/listings/:id` compiles and renders a JSON document.
    render(<RenterBookings outcome={hires()} />);

    expect(
      screen.getByRole('link', { name: 'Petrol hedge trimmer' }).getAttribute('href'),
    ).toBe('/hire/11111111-1111-4111-8111-111111111111');
  });

  it('shows the inclusive total and says the fees are in it', () => {
    // §3.4.4 wherever a price appears. The breakdown is not on this projection,
    // so a figure excluding fees is not available here rather than discouraged.
    render(<RenterBookings outcome={hires()} />);

    expect(screen.getByText('£58.32')).toBeVisible();
    expect(screen.getByText(/fees included/)).toBeVisible();
  });

  it('renders the title the booking kept, not one it looked up', () => {
    // §8.2. The copy is what lets a hire stay legible after a retitle, a pause
    // or an erasure of the listing behind it.
    render(
      <RenterBookings
        outcome={hires({ bookings: [hire({ itemTitle: 'As it was called then' })] })}
      />,
    );

    expect(screen.getByText('As it was called then')).toBeVisible();
  });

  it('tells somebody with no bookings where to start', () => {
    render(<RenterBookings outcome={hires({ bookings: [] })} />);

    expect(screen.getByText(/not asked to hire anything yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: /find something nearby/i })).toBeVisible();
  });

  it('never says the list is empty when it could not be read', () => {
    /*
     * The defect this file exists for. A person told their bookings are gone
     * will make them again — and one of them may be an accepted hire somebody
     * else is relying on.
     */
    render(<RenterBookings outcome={{ kind: 'unreachable', reason: 'timeout' }} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/);
    expect(screen.queryByText(/not asked to hire anything yet/)).toBeNull();
  });

  it('states the fact before the likeliest cause when signed out', () => {
    /*
     * The Phase 0–3 audit's finding: a signed-out stranger was told a session
     * they had never had was expired. "You are not signed in" is what we know;
     * the expiry is a guess and is worded as one.
     */
    render(<RenterBookings outcome={{ kind: 'signed-out' }} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /You are not signed in\. Your session may have expired/,
    );
  });

  it('says so when the list stopped short', () => {
    // ADR 0035. A list that quietly stops is one somebody reads as their whole
    // record.
    render(<RenterBookings outcome={hires({ truncated: true })} />);

    expect(screen.getByText(/This is not all of them/)).toBeVisible();
  });

  it('does not claim a cut when there was none', () => {
    render(<RenterBookings outcome={hires()} />);

    expect(screen.queryByText(/This is not all of them/)).toBeNull();
  });
});

describe('what is booked on an owner’s items', () => {
  it('states the owner’s own charge, and never a payout', () => {
    /*
     * §3.4 deducts commission from a payout and neither exists until Phase 5.
     * The renter's inclusive total on this row would read as what the owner
     * receives, which is the false-sentence class the audit found three of.
     */
    render(<OwnerBookingList outcome={lettings()} />);

    expect(screen.getByText('£54.00')).toBeVisible();
    expect(screen.getByText(/at your rates/)).toBeVisible();
    expect(screen.getByText(/before our commission/)).toBeVisible();
    // The renter's inclusive total for the same hire.
    expect(screen.queryByText('£58.32')).toBeNull();
  });

  it('does not name the renter', () => {
    // §8.4.1's posture, and `listingRequestSchema`'s decision: identity arrives
    // with commitment, and there is no mechanism for it until Phase 6.
    render(<OwnerBookingList outcome={lettings()} />);

    expect(screen.queryByText(/renter/i)).toBeNull();
  });

  it('links to the owner’s own page, where the answering happens', () => {
    // 4.6b put Accept and Decline beside §7.1's disclosure about what accepting
    // would displace. A second set of buttons here would be the same action in
    // two places, and this one would be the copy missing the warning.
    render(<OwnerBookingList outcome={lettings()} />);

    expect(
      screen
        .getByRole('link', { name: 'SDS+ rotary hammer drill' })
        .getAttribute('href'),
    ).toBe('/listings/22222222-2222-4222-8222-222222222222');
  });

  it('offers no way to accept or decline from here', () => {
    render(
      <OwnerBookingList
        outcome={lettings({ bookings: [letting({ state: 'REQUESTED' })] })}
      />,
    );

    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /decline/i })).toBeNull();
  });

  it('shows a waiting request rather than hiding it until it is answered', () => {
    render(
      <OwnerBookingList
        outcome={lettings({ bookings: [letting({ state: 'REQUESTED' })] })}
      />,
    );

    expect(screen.getByText('Waiting for your answer')).toBeVisible();
  });

  it('keeps showing a booking after it has been answered', () => {
    // The specific gap 4.6b left: an accepted booking left the requests panel
    // the moment it was answered and appeared nowhere else in the product.
    render(<OwnerBookingList outcome={lettings()} />);

    expect(screen.getByText('Confirmed')).toBeVisible();
  });

  it('does not tell an owner nobody has asked when the read failed', () => {
    /*
     * 4.6b shipped exactly this sentence to an owner who had just answered two
     * requests. The empty state here is worded about what has happened rather
     * than about what is on the page — and it must not render at all on a
     * failure.
     */
    render(<OwnerBookingList outcome={{ kind: 'unreachable', reason: 'timeout' }} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/);
    expect(screen.queryByText(/Nobody has asked/)).toBeNull();
  });

  it('tells an owner with nothing booked what will happen when somebody asks', () => {
    render(<OwnerBookingList outcome={lettings({ bookings: [] })} />);

    expect(screen.getByText(/Nobody has asked to hire your items yet/)).toBeVisible();
  });
});

describe('what reading the page found (slice 4.8b)', () => {
  it('tells the owner how many requests are waiting, when any are', () => {
    /*
     * **The blurb said this unconditionally and was shown to an owner with
     * nothing waiting** — an instruction aimed at nothing, found by looking at
     * the page rather than by any test here. It now belongs to the list, which
     * is the only thing that knows.
     */
    render(
      <OwnerBookingList
        outcome={lettings({
          bookings: [letting({ state: 'REQUESTED' }), letting({ id: 'b3' })],
        })}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent(/1 request is waiting for you/);
  });

  it('counts more than one properly', () => {
    render(
      <OwnerBookingList
        outcome={lettings({
          bookings: [
            letting({ state: 'REQUESTED' }),
            letting({ id: 'b3', state: 'REQUESTED' }),
          ],
        })}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent(
      /2 requests are waiting for you/,
    );
  });

  it('says nothing at all when everything has been answered', () => {
    // A count of nought is noise, and noise is what makes a real prompt
    // invisible — `OwnerRequests` makes the same argument for §7.1's conflict
    // line.
    render(<OwnerBookingList outcome={lettings()} />);

    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText(/waiting for you/)).toBeNull();
  });

  it('tells a renter when their waiting request lapses', () => {
    /*
     * `requestExpiresAt` was on the projection and rendered nowhere, while the
     * owner's panel has shown the same deadline since 4.6b. "It expires on its
     * own" without a date is half a fact about the only row with a clock on it.
     */
    render(
      <RenterBookings
        outcome={hires({
          bookings: [
            hire({ state: 'REQUESTED', requestExpiresAt: '2026-09-01T09:00:00.000Z' }),
          ],
        })}
      />,
    );

    expect(screen.getByText(/Expires/)).toHaveTextContent(/1 Sept 2026/);
  });

  it('does not show a deadline on a booking that is no longer waiting', () => {
    // On an answered or lapsed booking the deadline is history, and the state's
    // own sentence already says what became of it.
    render(<RenterBookings outcome={hires()} />);

    expect(screen.queryByText(/Expires/)).toBeNull();
  });
});
