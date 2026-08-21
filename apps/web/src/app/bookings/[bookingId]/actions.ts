'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { clientIpFrom } from '../../../lib/client-ip';
import { payForBooking } from '../../../lib/bookings';
import { webEnv } from '../../../lib/env';
import { bookingDetailPath } from '../../../lib/page-paths';
import { payRefused } from './pay-state';
import type { PayPanelState } from './pay-state';

/**
 * The renter pays (§8.7, slice 5.2d).
 *
 * **The booking id comes off a hidden field rather than the route params**, which
 * is what lets the panel be a plain component the page hands a booking to — a
 * server action cannot read the URL it was submitted from. It is not a trust
 * boundary either way: the API scopes the write to the caller's own bookings and
 * answers 404 to everybody else, so a forged id names a booking that is not
 * theirs and gets nothing.
 *
 * **It revalidates on every outcome that could have moved the booking**, unlike
 * `requestPanelAction`, which deliberately revalidates nothing. The difference is
 * §7: a request leaves the listing page saying exactly what it said before, while
 * a payment moves `ACCEPTED → AWAITING_PAYMENT → RESERVED` and the page around
 * this panel renders that state, the event history and the payability. Not
 * revalidating would leave a renter looking at *"accepted, awaiting payment"*
 * immediately after paying.
 *
 * **A refusal revalidates too**, which looks unnecessary and is not: the commonest
 * 422 is *"that booking changed while you were paying"*, and the whole remedy is
 * for the page to redraw with where it actually stands.
 */
export async function payAction(
  _previous: PayPanelState,
  form: FormData,
): Promise<PayPanelState> {
  const bookingId = String(form.get('bookingId') ?? '');
  if (bookingId === '') {
    /*
     * Unreachable through the page — the field is rendered beside the button.
     * Handled rather than assumed, because the value arrives from the client and
     * "there is no booking" has to be a sentence rather than a crash.
     */
    return payRefused('That booking is no longer on this page. Reload and try again.');
  }

  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await payForBooking(
    webEnv().API_BASE_URL,
    token,
    bookingId,
    undefined,
    clientIp,
  );

  /*
   * **Unconditional, and it is reached only after a real call.** The one path
   * that does not revalidate returns above, before the request is made — nothing
   * can have moved when we never asked. Every outcome from here down either moved
   * the booking or means the page is showing something stale, and both are fixed
   * by redrawing.
   */
  revalidatePath(bookingDetailPath(bookingId));

  return describe(outcome);
}

/**
 * One outcome, as the panel reads it.
 *
 * **Exhaustive over both unions**, so a new payment status or a new fetch outcome
 * is a compile error here rather than a blank panel on the one page in the
 * product where money changes hands.
 */
function describe(outcome: Awaited<ReturnType<typeof payForBooking>>): PayPanelState {
  switch (outcome.kind) {
    case 'loaded': {
      const { payment, booking } = outcome.value;

      switch (payment.status) {
        case 'succeeded':
          return { status: 'paid', booking };
        case 'processing':
          return { status: 'processing' };
        case 'pending_payer_action':
          return { status: 'action-needed' };
        case 'failed':
          /*
           * **The provider's sentence if there is one, ours if there is not.**
           * `failureMessage` is optional on the contract and a failure with no
           * reason must still say something a renter can act on — 5.2c
           * deliberately projects no reason *code*, so there is nothing to
           * translate and nothing to guess at.
           */
          return {
            status: 'failed',
            message:
              payment.failureMessage ??
              'That payment did not go through. Nothing has been charged — try again, or use another card.',
          };
        default: {
          const unhandled: never = payment.status;
          return payRefused(String(unhandled));
        }
      }
    }

    case 'refused':
      return { status: 'refused', message: outcome.reason };

    case 'signed-out':
      return payRefused(
        'You are not signed in. Your session may have expired — sign in and try again. Nothing has been charged.',
      );

    /*
     * **`not-found` is "not yours or no such booking"** and the API refuses to say
     * which (5.2c). The sentence covers both without confirming either.
     */
    case 'not-found':
      return payRefused(
        'That booking could not be found. Reload the page to see where it stands.',
      );

    /*
     * The remaining kinds are failures to reach or read the API. They collapse to
     * one sentence for `RenterBookings`' reason — none is something a renter can
     * act on differently — and the thing they all must say is that **no money
     * moved**, because that is the only question somebody has after pressing pay.
     */
    case 'forbidden':
    case 'invalid':
    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return payRefused(
        'We could not reach the payment service just now. Nothing has been charged — try again in a moment.',
      );

    default: {
      const unhandled: never = outcome;
      return payRefused(String(unhandled));
    }
  }
}
