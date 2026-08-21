'use client';

import { useActionState } from 'react';
import { Money } from '@platform/core';
import type { BookingDetail } from '@platform/contracts';
import { payAction } from '../app/bookings/[bookingId]/actions';
import { INITIAL_PAY_STATE } from '../app/bookings/[bookingId]/pay-state';
import type { PayPanelState } from '../app/bookings/[bookingId]/pay-state';
import styles from './booking-payment.module.css';

/**
 * Where a renter pays for a booking their owner accepted (§8.7, slice 5.2d).
 *
 * ## The button is absent rather than greyed, and that is the decision
 *
 * CLAUDE.md forbids dead controls: every button either calls real behaviour or is
 * visibly feature-flagged. **Today `booking.payment` is off in every environment**
 * — there is no payment provider until 5.2e — so the honest state of this panel
 * is that paying is not possible, and it has to *say so* rather than offer
 * something that cannot work.
 *
 * **A disabled *Pay* button was the obvious shape and it is the wrong one**,
 * because `payability` is false for four different reasons and only one of them
 * is temporary. A greyed button reads as *"soon"* — which is true of the switch,
 * misleading for a booking that is already paid for, and simply wrong for an
 * owner, who is not the payer at all. One control that means four things is worse
 * than a sentence that means one.
 *
 * So: **the reason, always, and the button only when it would work.** The
 * sentence comes from the API (`payability.ts`) and is the same one the route
 * refuses with, so the page and the 422 cannot tell a renter two stories.
 *
 * ## What is deliberately not here
 *
 * **No 3-D Secure challenge.** `pending_payer_action` renders an honest sentence
 * and no token: running a challenge needs the provider's own browser library,
 * which arrives with the adapter in 5.2e. Nothing here parses, stores or logs a
 * payer-action token, and today none can exist.
 */
export function BookingPayment({ booking }: { readonly booking: BookingDetail }) {
  const [state, action, pending] = useActionState(payAction, INITIAL_PAY_STATE);

  return (
    <section className={styles.panel} aria-labelledby="payment">
      <h2 id="payment" className={styles.heading}>
        Payment
      </h2>

      <Outcome state={state} />

      {booking.payability.payable ? (
        <form action={action} className={styles.form}>
          <input type="hidden" name="bookingId" value={booking.id} />

          {/*
            **The total, on the button.** §3.4.4 requires the inclusive figure
            wherever a price is shown, and the moment somebody commits money is the
            least acceptable place to make them look elsewhere for it.
          */}
          <button type="submit" className={styles.pay} disabled={pending}>
            {pending ? 'Paying…' : `Pay ${Money.format(booking.total)}`}
          </button>

          <p className={styles.note}>
            Fees included. You will not be charged more than this.
          </p>
        </form>
      ) : (
        /*
         * **`role="status"`, not `role="alert"`.** Most of these are ordinary
         * facts about a booking — already paid for, not yours to pay — and an
         * assertive announcement would interrupt a screen-reader user to tell them
         * something is fine. The failures below use `alert` because they follow an
         * action somebody just took.
         */
        <p role="status" className={styles.unavailable}>
          {booking.payability.reason}
        </p>
      )}
    </section>
  );
}

/**
 * What became of the last attempt.
 *
 * **Exhaustive**, so a state added to `PayPanelState` is a compile error rather
 * than silence on the one panel in the product that moves money.
 */
function Outcome({ state }: { readonly state: PayPanelState }) {
  switch (state.status) {
    case 'idle':
      return null;

    case 'paid':
      return (
        <p role="status" className={styles.paid}>
          <strong>Paid.</strong> Your booking is confirmed and the dates are held.
        </p>
      );

    case 'processing':
      return (
        <p role="status" className={styles.pending}>
          Your payment is going through. Nothing more is needed from you — reload this
          page in a moment to see it confirmed.
        </p>
      );

    /*
     * **The one state that cannot happen yet, written honestly rather than
     * optimistically.** It needs the provider's browser library, which is 5.2e's.
     * Saying "we could not finish this here" is true; drawing a challenge that
     * does not exist would not be.
     */
    case 'action-needed':
      return (
        <p role="alert" className={styles.pending}>
          Your bank needs to check this payment before it can go through, and we cannot
          finish that here yet. Nothing has been charged.
        </p>
      );

    case 'failed':
      return (
        <p role="alert" className={styles.problem}>
          {state.message}
        </p>
      );

    /*
     * **Verbatim.** 5.2c writes these for the renter reading them, and every one
     * of them already says whether anything was charged — which is the only
     * question somebody has after pressing pay.
     */
    case 'refused':
      return (
        <p role="alert" className={styles.problem}>
          {state.message}
        </p>
      );

    default: {
      const unhandled: never = state;
      return <p role="alert">{String(unhandled)}</p>;
    }
  }
}
