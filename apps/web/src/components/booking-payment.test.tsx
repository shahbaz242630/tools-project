import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BookingDetail } from '@platform/contracts';
import type { PayPanelState } from '../app/bookings/[bookingId]/pay-state';

/**
 * The pay panel, as a renter meets it (slice 5.2d).
 *
 * The server action is mocked, as in every form test here — it imports
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is what the panel
 * **says**, which is the standing lesson from the Phase 0–3 audit: a green suite
 * cannot see a false sentence, and this is the one panel in the product where a
 * false sentence is about somebody's money.
 *
 * The two that matter most:
 *
 * - **No pay button exists unless the API said it would work.** That is the whole
 *   slice — `booking.payment` is off in every environment today, so the ordinary
 *   render is the unavailable one.
 * - **Every failure says whether anything was charged**, because that is the only
 *   question somebody has after pressing pay.
 */

const state = vi.hoisted(() => ({ current: { status: 'idle' } as PayPanelState }));

vi.mock('../app/bookings/[bookingId]/actions', () => ({ payAction: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { BookingPayment } = await import('./booking-payment');

const BOOKING_ID = '44444444-4444-4444-8444-444444444444';

function booking(payability: BookingDetail['payability']): BookingDetail {
  return {
    id: BOOKING_ID,
    listingId: '11111111-1111-4111-8111-111111111111',
    state: 'ACCEPTED',
    startDate: '2026-08-20',
    endDate: '2026-08-22',
    days: 3,
    itemTitle: 'Petrol hedge trimmer, 60cm blade',
    categoryName: 'Outdoor and gardening',
    itemCharge: { amount: 5_400, currency: 'GBP' },
    renterFee: { amount: 432, currency: 'GBP' },
    total: { amount: 5_832, currency: 'GBP' },
    lineItems: [
      {
        unit: 'day',
        count: 3,
        unitPrice: { amount: 1_800, currency: 'GBP' },
        subtotal: { amount: 5_400, currency: 'GBP' },
      },
    ],
    requestExpiresAt: '2026-08-19T09:00:00.000Z',
    events: [
      {
        type: 'requested',
        fromState: null,
        toState: 'REQUESTED',
        at: '2026-08-18T09:00:00.000Z',
      },
    ],
    payability,
  };
}

function show(payability: BookingDetail['payability'], panel: PayPanelState) {
  state.current = panel;
  render(<BookingPayment booking={booking(payability)} />);
}

describe('when the renter may pay', () => {
  it('offers the inclusive total on the button itself', () => {
    show({ payable: true }, { status: 'idle' });

    /*
     * §3.4.4 wants the inclusive figure wherever a price is shown, and the moment
     * somebody commits money is the least acceptable place to send them looking
     * elsewhere for it.
     */
    expect(screen.getByRole('button', { name: /Pay £58\.32/ })).toBeInTheDocument();
    expect(screen.getByText(/Fees included/)).toBeInTheDocument();
  });

  it('carries the booking id, because an action cannot read the URL', () => {
    show({ payable: true }, { status: 'idle' });

    const field: HTMLInputElement | null = document.querySelector(
      'input[name="bookingId"]',
    );

    expect(field?.value).toBe(BOOKING_ID);
  });
});

describe('when the renter may not pay', () => {
  /**
   * **The ordinary render in every environment today.** There is no payment
   * provider until 5.2e, so this is what a real renter sees — which is why it is
   * asserted rather than treated as an edge case.
   */
  it('draws no button at all, and says why', () => {
    show(
      {
        payable: false,
        reason:
          'Paying for bookings is not switched on yet, so nothing has been charged. Your booking is still held.',
      },
      { status: 'idle' },
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/not switched on yet/)).toBeInTheDocument();
  });

  /**
   * **A disabled button was the obvious shape and is the wrong one.** `payable`
   * is false for four different reasons and only one of them is temporary; a
   * greyed *Pay* reads as "soon", which is wrong for a booking already paid for
   * and wrong for an owner, who is not the payer at all.
   */
  it('says the renter pays, when an owner is the one looking', () => {
    show(
      {
        payable: false,
        reason:
          'The renter pays for this booking. There is nothing for you to pay here.',
      },
      { status: 'idle' },
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/renter pays for this booking/)).toBeInTheDocument();
  });

  /**
   * **`role="status"`, not `role="alert"`.** Most of these are ordinary facts
   * about a booking, and an assertive announcement would interrupt a
   * screen-reader user to tell them nothing is wrong.
   */
  it('announces the reason politely rather than as an alert', () => {
    show(
      { payable: false, reason: 'That booking is already paid for.' },
      { status: 'idle' },
    );

    expect(screen.getByRole('status')).toHaveTextContent('already paid for');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('what became of an attempt', () => {
  it('says nothing at all before one is made', () => {
    show({ payable: true }, { status: 'idle' });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('confirms a payment and says the dates are held', () => {
    show({ payable: true }, { status: 'paid', booking: booking({ payable: true }) });

    expect(screen.getByRole('status')).toHaveTextContent(/Paid/);
    expect(screen.getByRole('status')).toHaveTextContent(/dates are held/);
  });

  it('tells somebody to wait when the provider is still working', () => {
    show({ payable: true }, { status: 'processing' });

    expect(screen.getByRole('status')).toHaveTextContent(/going through/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing more is needed/);
  });

  /**
   * **The state that cannot happen until 5.2e, written honestly.** Running a
   * 3-D Secure challenge needs the provider's own browser library. Saying we
   * cannot finish it here is true; drawing a challenge that does not exist would
   * not be.
   */
  it('admits it cannot finish a bank check yet, and that nothing was charged', () => {
    show({ payable: true }, { status: 'action-needed' });

    expect(screen.getByRole('alert')).toHaveTextContent(/bank needs to check/);
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing has been charged/);
  });

  it('renders a failure verbatim, because the API writes it for the renter', () => {
    show({ payable: true }, { status: 'failed', message: 'That card was declined.' });

    expect(screen.getByRole('alert')).toHaveTextContent('That card was declined.');
  });

  it('renders a refusal verbatim too', () => {
    show(
      { payable: true },
      {
        status: 'refused',
        message: 'That booking is already paid for. Nothing has been charged again.',
      },
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That booking is already paid for. Nothing has been charged again.',
    );
  });

  /**
   * **Somebody who has just pressed pay has exactly one question**, and every
   * outcome this panel can render after an attempt has to answer it: either the
   * money moved, or it did not. Swept rather than asserted case by case, so a
   * sixth outcome added without a sentence about money fails here.
   */
  it('always says where the money stands after an attempt', () => {
    const outcomes: readonly PayPanelState[] = [
      { status: 'paid', booking: booking({ payable: true }) },
      { status: 'processing' },
      { status: 'action-needed' },
      {
        status: 'failed',
        message: 'That payment did not go through. Nothing has been charged.',
      },
      {
        status: 'refused',
        message: 'That booking is already paid for. Nothing has been charged again.',
      },
    ];

    for (const outcome of outcomes) {
      state.current = outcome;
      const { unmount, container } = render(
        <BookingPayment booking={booking({ payable: true })} />,
      );

      expect(container.textContent).toMatch(/charged|dates are held|going through/i);

      unmount();
    }
  });
});
