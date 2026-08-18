/**
 * What the request panel's controls report back (BRD §8.5.2, §8.6, slice 4.5b).
 *
 * **A `'use server'` file may export only async functions** (slice 2.4a), which
 * is why this sits beside `actions.ts` rather than in it.
 *
 * **One state for a two-step flow, not two.** Asking for a price and asking for
 * the item are separate requests to separate routes, and they are still one
 * conversation: the quote is the input to the request, and a refusal at either
 * step returns the person to the same three fields with the same dates in them.
 * Two `useActionState` hooks would each own half of that and neither would be
 * able to redraw the other's half — a refused request would have had to leave
 * the quote on screen, priced, beside an explanation of why it could not be
 * taken.
 */

import type { Booking, RentalQuote } from '@platform/contracts';

/** What was typed, so that a refusal does not empty the form. */
export interface SubmittedRequest {
  readonly startDate: string;
  readonly endDate: string;
  readonly postcode: string;
}

/**
 * Where the panel is in the two steps.
 *
 * **A union rather than a status plus four nullable fields**, so the component
 * cannot render a total it does not have. The alternative shape — `quote:
 * RentalQuote | null` beside `status` — compiles perfectly while somebody reads
 * a price off a null, and this is a slice about showing people money.
 *
 * **`quoted` carries no `submitted`, deliberately.** The quote *is* what was
 * submitted, and it is the server's copy of it: its `startDate`, `endDate` and
 * `postcode` are the ones the price was computed from. Keeping a second copy
 * beside it would create two answers to "which dates is this £58.32 for", and
 * the wrong one would be the one the form redraws.
 */
export type RequestPanelState =
  | { readonly status: 'idle'; readonly submitted: SubmittedRequest }
  | {
      readonly status: 'error';
      /** Rendered verbatim — it is written for the person reading it. */
      readonly message: string;
      readonly submitted: SubmittedRequest;
    }
  | { readonly status: 'quoted'; readonly quote: RentalQuote }
  | { readonly status: 'requested'; readonly booking: Booking };

/** No values at all — the panel's starting point, and its only default. */
export const NOTHING_SUBMITTED: SubmittedRequest = {
  startDate: '',
  endDate: '',
  postcode: '',
};

export const INITIAL_REQUEST_STATE: RequestPanelState = {
  status: 'idle',
  submitted: NOTHING_SUBMITTED,
};

/**
 * A refusal carrying a sentence, and whatever was typed.
 *
 * **`submitted` has no default and that is on purpose.** The calendar's
 * equivalent defaults to nothing typed, which is right there because one of its
 * two controls has nothing to echo. Every path into this one came from a form
 * with three fields in it, so a default would only ever be a way to forget them
 * — React 19 resets an uncontrolled form when its action completes, and this
 * codebase has now lost somebody's typing that way in 2.4c-i, 2.5a, 2.7a and
 * 4.3b.
 */
export function requestError(
  message: string,
  submitted: SubmittedRequest,
): RequestPanelState {
  return { status: 'error', message, submitted };
}

/**
 * What was typed, read off the form.
 *
 * Here rather than in `actions.ts` so that the echo and the parse read the same
 * three fields: a `trim()` on one side and not the other is how a refusal comes
 * back with a value subtly different from the one that caused it.
 */
export function submittedIn(form: FormData): SubmittedRequest {
  return {
    startDate: String(form.get('startDate') ?? '').trim(),
    endDate: String(form.get('endDate') ?? '').trim(),
    postcode: String(form.get('postcode') ?? '').trim(),
  };
}

/**
 * The dates a quote was made for, as the form's own fields.
 *
 * What *Change dates* redraws with. It comes off the quote rather than out of a
 * hidden input, because the quote is the server's record of what was asked and a
 * hidden input is a copy somebody can edit.
 */
export function submittedFrom(quote: RentalQuote): SubmittedRequest {
  return {
    startDate: quote.startDate,
    endDate: quote.endDate,
    postcode: quote.postcode,
  };
}
