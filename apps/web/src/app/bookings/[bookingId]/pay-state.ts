/**
 * What the pay control reports back (§8.7, slice 5.2d).
 *
 * **A `'use server'` file may export only async functions** (slice 2.4a), which
 * is why this sits beside `actions.ts` rather than in it — the rule
 * `request-state.ts` already follows.
 *
 * **A union rather than a status beside four nullable fields**, for the reason
 * `RequestPanelState` gives: the wrong shape compiles perfectly while somebody
 * renders a message off a null, and this is a panel about taking money.
 */

import type { Booking } from '@platform/contracts';

/**
 * Where a payment attempt got to, as the page tells it.
 *
 * **Five cases from the API's four statuses plus a refusal**, and the mapping is
 * deliberately not one-to-one. `pending_payer_action` and `processing` both leave
 * the booking in `AWAITING_PAYMENT` (5.2a) and are still different sentences here:
 * one asks the payer to do something, the other asks them to wait, and collapsing
 * them would tell somebody staring at a 3-D Secure prompt that nothing is
 * required of them.
 *
 * **`refused` carries the API's own words.** 5.2c writes those sentences for the
 * renter reading them — *"That booking is already paid for. Nothing has been
 * charged again."* — and anything this layer added would talk over the one place
 * that knows what happened.
 */
export type PayPanelState =
  | { readonly status: 'idle' }
  /** The money moved. §7 has the booking in `RESERVED`. */
  | { readonly status: 'paid'; readonly booking: Booking }
  /** Taken, not yet settled. Nothing for the payer to do but look again. */
  | { readonly status: 'processing' }
  /**
   * The provider needs the payer to authenticate (SCA).
   *
   * **Carries no token, deliberately.** `payerAction.token` is a short-lived
   * bearer value for the provider's own browser library, and there is no such
   * library until 5.2e — so putting it in this state now would move a credential
   * into a React tree for nothing to read. 5.2e is where the token and the
   * challenge arrive together.
   */
  | { readonly status: 'action-needed' }
  /** The card was declined, or authentication failed. Retrying is §7's edge. */
  | { readonly status: 'failed'; readonly message: string }
  /** The attempt was refused before any money moved — a 422, verbatim. */
  | { readonly status: 'refused'; readonly message: string };

export const INITIAL_PAY_STATE: PayPanelState = { status: 'idle' };

/** A refusal, in the API's words where we have them. */
export function payRefused(message: string): PayPanelState {
  return { status: 'refused', message };
}
