/**
 * What the owner's accept and decline controls report back (BRD §8.6, §7.1,
 * slice 4.6b).
 *
 * **A `'use server'` file may export only async functions** (slice 2.4a), which
 * is why this sits beside `request-decisions.ts` rather than in it.
 *
 * **One shape for both controls, and one control per request.** Like the
 * calendar's pair they are not mutually exclusive — a page can hold several
 * requests, each with its own Accept and Decline — so what is shared is the
 * *type*, and each control owns its own state. Nothing is echoed back, because
 * nothing was typed: there is no form here to be emptied by React 19's reset.
 */

export interface RequestDecisionState {
  readonly status: 'idle' | 'error' | 'accepted' | 'declined';
  /** Empty while idle. Rendered verbatim — it is written for the reader. */
  readonly message: string;
}

export const INITIAL_DECISION_STATE: RequestDecisionState = {
  status: 'idle',
  message: '',
};

export function decisionError(message: string): RequestDecisionState {
  return { status: 'error', message };
}

/**
 * What an owner is told once they have accepted.
 *
 * **It names the irreversibility again, after the fact as well as before.** §7
 * gives `ACCEPTED` no cancel edge until `RESERVED`, which is Phase 5 — so this
 * is genuinely permanent today, and the warning on the button is not the only
 * place somebody should meet that. The count of auto-declined requests is not
 * mentioned here: it is on the panel, before the decision, where §7.1 requires
 * it.
 */
export function accepted(): RequestDecisionState {
  return {
    status: 'accepted',
    message:
      'Accepted. Those dates are now held for this renter and cannot be freed ' +
      'again yet — cancelling arrives with payments.',
  };
}

export function declined(): RequestDecisionState {
  return {
    status: 'declined',
    message: 'Declined. The dates stay open, and other requests are unaffected.',
  };
}
