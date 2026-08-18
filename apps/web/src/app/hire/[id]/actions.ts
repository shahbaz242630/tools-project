'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { ContractViolationError, parseQuoteRequest } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { asStandaloneSentence } from '../../../lib/contract-issues';
import { requestBooking } from '../../../lib/bookings';
import { requestQuote } from '../../../lib/quotes';
import { webEnv } from '../../../lib/env';
import {
  INITIAL_REQUEST_STATE,
  NOTHING_SUBMITTED,
  requestError,
  submittedFrom,
  submittedIn,
} from './request-state';
import type { RequestPanelState, SubmittedRequest } from './request-state';

/**
 * The renter's two steps — ask what a period costs, then ask for it (BRD
 * §8.5.2, §8.6, slice 4.5b).
 *
 * **One action with an intent, rather than three actions.** The three moves share
 * one state machine and each one's outcome is the next one's input: a refused
 * request has to redraw the form the quote came from, and a *Change dates* has to
 * put the quote's own dates back into it. Separate actions would each hold a
 * fragment of that and would have to agree about the rest.
 *
 * **The intent comes off the submit button that was pressed** — `name="intent"`
 * on a `<button type="submit">` is submitted with the form, which is ordinary
 * HTML and works before React has hydrated anything.
 *
 * **Nothing here revalidates the page**, unlike the calendar's actions, and the
 * reason is §7.1: a `REQUESTED` booking is deliberately non-blocking, so nothing
 * a server component on this page renders has changed. Calling `revalidatePath`
 * anyway would redraw the listing to prove it looked the same.
 */
export async function requestPanelAction(
  previous: RequestPanelState,
  form: FormData,
): Promise<RequestPanelState> {
  const intent = String(form.get('intent') ?? '');

  if (intent === 'change') {
    /*
     * **Back to the form, with the dates the price was quoted for.** They come
     * off the quote rather than off the form, because by this point the form is
     * showing them as text: the fields were replaced by the quote, which is what
     * stops somebody editing a date and then pressing *Request this hire* for a
     * price that was computed from a different one.
     */
    return previous.status === 'quoted'
      ? { status: 'idle', submitted: submittedFrom(previous.quote) }
      : INITIAL_REQUEST_STATE;
  }

  if (intent === 'request') {
    if (previous.status !== 'quoted') {
      /*
       * Unreachable through the page — the button only exists beside a quote.
       * Handled rather than assumed, because the state arrives from the client
       * and "there is no quote" must be a sentence rather than a crash.
       */
      return requestError(
        'That price is no longer on this page. Ask for it again.',
        NOTHING_SUBMITTED,
      );
    }

    return submitRequest(previous.quote.id, submittedFrom(previous.quote));
  }

  return submitQuote(form);
}

/** Step one: what does this period cost? */
async function submitQuote(form: FormData): Promise<RequestPanelState> {
  /*
   * **Read once, and carried back on every refusal below.** React 19 resets an
   * uncontrolled form when its action completes, so a return that does not carry
   * these empties all three fields behind the explanation of why they were
   * refused — which is how somebody is left retyping dates that were nearly
   * right. It is the fifth time this codebase has met it.
   */
  const submitted = submittedIn(form);

  const listingId = String(form.get('listingId') ?? '').trim();
  if (listingId === '') {
    return requestError(
      'That listing could not be identified. Reload the page and try again.',
      submitted,
    );
  }

  /*
   * **Parsed here, and only the rules that need nothing but these three values.**
   * The ordering of two dates and the shape of a postcode are decided by what is
   * in front of us, and telling somebody about either after a round trip is a
   * worse way to find out.
   *
   * **Everything with a clock or a calendar in it stays the API's** — already
   * past, longer than the category allows, blocked, booked, below the minimum
   * booking total. Those arrive as 422 and are rendered verbatim. A copy of them
   * here would be a second place each rule lives and the easier of the two to
   * forget when a number changes.
   */
  let period;
  try {
    period = parseQuoteRequest(submitted);
  } catch (error) {
    if (error instanceof ContractViolationError) {
      return requestError(
        asStandaloneSentence(error.issues, 'Those dates were not accepted.'),
        submitted,
      );
    }
    throw error;
  }

  const { getToken } = await auth();
  const outcome = await requestQuote(
    webEnv().API_BASE_URL,
    await getToken(),
    listingId,
    period,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      return { status: 'quoted', quote: outcome.value };

    case 'refused':
      // The API's own sentence, unprefixed. Nothing is broken and nothing was
      // half-done: the platform declined to price a period, in words written for
      // the person who chose it.
      return requestError(outcome.reason, submitted);

    case 'not-found':
      /*
       * **One sentence for four facts**, matching the API's refusal to unpick
       * them: no such listing, not published, hidden by the platform, or an
       * owner who is not a private individual. Saying which would tell a
       * stranger something the route was careful not to confirm.
       */
      return requestError(
        'This item cannot be booked at the moment. It may have been withdrawn.',
        submitted,
      );

    case 'forbidden':
      return requestError(
        'Your account cannot book items at the moment. If it has been suspended, ' +
          'the reason is on your account page.',
        submitted,
      );

    case 'signed-out':
      return signedOut(submitted, 'ask for a price again');

    case 'invalid':
      return requestError(outcome.issues.join('; '), submitted);

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      /*
       * `stale-category` cannot arrive here — no category is pinned by a form
       * that types three values — and it is in the union because this shares the
       * listings client. Grouped with the generic failures rather than given a
       * sentence describing something that did not happen.
       */
      return requestError(`That did not complete — ${outcome.reason}`, submitted);
  }
}

/** Step two: ask the owner for it (§8.6). */
async function submitRequest(
  quoteId: string,
  submitted: SubmittedRequest,
): Promise<RequestPanelState> {
  const { getToken } = await auth();
  const outcome = await requestBooking(
    webEnv().API_BASE_URL,
    await getToken(),
    quoteId,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      return { status: 'requested', booking: outcome.value };

    case 'refused':
      /*
       * **Back to the form rather than back to the quote**, and every member of
       * this branch is why: the price expired, the listing was withdrawn, or the
       * dates went while the quote was on screen. In all three the quote is now
       * describing a hire that cannot happen, and leaving it on the page priced
       * and unbuyable would be the platform arguing with itself. The dates stay
       * in the fields, so asking again is one button.
       */
      return requestError(outcome.reason, submitted);

    case 'not-found':
      // The quote is not this person's, or has gone. The API refuses to say
      // which, and both readings are the same instruction.
      return requestError(
        'That price could not be found. Ask for the dates again.',
        submitted,
      );

    case 'forbidden':
      return requestError(
        'Your account cannot book items at the moment. If it has been suspended, ' +
          'the reason is on your account page.',
        submitted,
      );

    case 'signed-out':
      return signedOut(submitted, 'ask again');

    case 'invalid':
      return requestError(outcome.issues.join('; '), submitted);

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      /*
       * **"Not sent" is the load-bearing half of this sentence.** A request that
       * timed out may or may not have reached the API, and the honest thing to
       * say is what we know: this page did not get an answer. Reloading is what
       * settles it — 4.8's dashboard is where a renter will be able to see their
       * requests, and until it exists this is the whole of the recovery.
       */
      return requestError(
        `That did not complete — ${outcome.reason}. The request may not have been ` +
          'sent; reload the page before asking again.',
        submitted,
      );
  }
}

/**
 * The wording every action in this app settled on, and the reason it is shared.
 *
 * **The state first, the likeliest cause second.** "Your session has expired" is
 * a claim about a session we cannot vouch for, and the Phase 0–3 audit found it
 * being shown to people who had never had one. This page is reachable without
 * signing in — it is the one page in the product that is — so getting this
 * wrong here would be getting it wrong in front of the largest audience.
 */
function signedOut(submitted: SubmittedRequest, andThen: string): RequestPanelState {
  return requestError(
    `You are not signed in, so nothing was sent. Your session may have expired — ` +
      `sign in again and ${andThen}.`,
    submitted,
  );
}
