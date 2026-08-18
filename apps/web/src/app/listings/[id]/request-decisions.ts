'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { clientIpFrom } from '../../../lib/client-ip';
import { ownerListingPath } from '../../../lib/page-paths';
import { acceptRequest, declineRequest } from '../../../lib/requests';
import { webEnv } from '../../../lib/env';
import { accepted, declined, decisionError } from './request-state';
import type { RequestDecisionState } from './request-state';

/**
 * Answering a request (BRD §8.6, §7.1, slice 4.6b).
 *
 * **One action with an intent, and one state for the whole panel** — which is
 * the shape 4.5b's renter panel uses, arrived at here by walking the page rather
 * than by design. The first version gave every request its own pair of actions
 * and its own state, mirroring the calendar's add/remove pair. It worked, and it
 * lost the confirmation every time:
 *
 * **an answered request leaves the waiting list.** `revalidatePath` re-reads it,
 * the answered one is gone, and the component holding *"Accepted. Those dates
 * are now held…"* unmounts with it. The owner pressed a button, the row vanished,
 * and the sentence explaining what they had just done permanently — including
 * that it cannot be undone — was never read. State that must outlive the row
 * cannot live on the row.
 *
 * So the panel owns one state, both buttons on every request dispatch to it, and
 * the outcome is rendered above the list where nothing removes it.
 *
 * **The revalidate stays.** An answer genuinely changes what a server component
 * renders — the request leaves, and an acceptance takes every conflicting one
 * with it (§7.1). Without it the owner would be looking at a list that still
 * showed both, which reads exactly like a button that does nothing.
 */
export async function answerRequestAction(
  _previous: RequestDecisionState,
  form: FormData,
): Promise<RequestDecisionState> {
  const listingId = String(form.get('listingId') ?? '').trim();
  const bookingId = String(form.get('bookingId') ?? '').trim();
  const intent = String(form.get('intent') ?? '');

  if (listingId === '' || bookingId === '') {
    return decisionError(
      'That request could not be identified. Reload the page and try again.',
    );
  }

  if (intent !== 'accept' && intent !== 'decline') {
    /*
     * Unreachable through the page — both buttons carry one of the two. Handled
     * rather than assumed, because the alternative to a sentence here is
     * silently doing one of them, and the two are not equally undoable.
     */
    return decisionError(
      'That answer was not understood. Reload the page and try again.',
    );
  }

  const { getToken } = await auth();
  const outcome = await (intent === 'accept' ? acceptRequest : declineRequest)(
    webEnv().API_BASE_URL,
    await getToken(),
    bookingId,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      /*
       * **A page path, never the API path.** `revalidatePath` silently does
       * nothing when handed one that matches no route — see `page-paths.ts`.
       */
      revalidatePath(ownerListingPath(listingId));
      return intent === 'accept' ? accepted() : declined();

    case 'refused':
      // The API's own sentence, unprefixed. Nothing is broken: the platform
      // declined to act, in words written for the person who pressed the button.
      return decisionError(outcome.reason);

    case 'taken':
      /*
       * **Its own branch, not folded into `refused`.** Nothing the owner changes
       * fixes this and it is not their mistake — somebody else's acceptance holds
       * the period. Telling them to try again would point them at the one thing
       * that cannot work.
       */
      return decisionError(
        `${outcome.reason} The renter has not been charged, and the request has ` +
          'been left as it was.',
      );

    case 'not-found':
      // "Not yours" and "no such request" arrive as one 404 on purpose. The
      // sentence has to be true of both, so it says what is on the page now.
      return decisionError(
        'That request is no longer on this listing. Reload the page to see what is.',
      );

    case 'forbidden':
      // Reachable, and ADR 0024's rule rather than an exception to it: reading
      // what is waiting survives suspension, and answering it does not.
      return decisionError(
        'You cannot answer requests while your account is suspended. The request ' +
          'is unchanged, and the reason is on your account page.',
      );

    case 'signed-out':
      /*
       * **The state first, the likeliest cause second** — the wording every
       * action in this app settled on, because "your session has expired" is a
       * claim about a session we cannot vouch for.
       */
      return decisionError(
        'You are not signed in, so nothing was sent and the request is unchanged. ' +
          'Your session may have expired — sign in again and answer it once more.',
      );

    case 'invalid':
      return decisionError(outcome.issues.join('; '));

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      /*
       * **"May not have been sent" is the load-bearing half.** A decision that
       * timed out may or may not have reached the API, and accepting is not
       * something to guess about: reloading is what settles it.
       */
      return decisionError(
        `That did not complete — ${outcome.reason}. It may not have been sent; ` +
          'reload the page before trying again.',
      );
  }
}
