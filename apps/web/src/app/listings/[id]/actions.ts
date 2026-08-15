'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { listingPath } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { pauseListing, publishListing } from '../../../lib/listings';
import { webEnv } from '../../../lib/env';
import { INITIAL_PUBLICATION_STATE } from './publication-state';
import type { PublicationActionState } from './publication-state';

/**
 * Publishing a listing (§8.3, slice 2.8a).
 *
 * **Nothing is checked here before the request goes.** Every other form in this
 * application validates in the browser as a convenience, because a round trip to
 * be told "title: must be at least 3 characters" is a poor way to find out. This
 * one deliberately does not: the completeness rules read the *pinned* category
 * version's schema, which the page does not hold, and a second implementation
 * that guessed would be the one that drifts — telling somebody their listing is
 * ready and then having the API refuse it.
 *
 * So the button always asks, and the API always answers. The 422 carries every
 * unmet requirement, which is what the page renders.
 *
 * **The state and its initial value live in `publication-state.ts`.** A
 * `'use server'` file may export only async functions (slice 2.4a).
 */
export async function publishListingAction(
  _previous: PublicationActionState,
  form: FormData,
): Promise<PublicationActionState> {
  const id = String(form.get('listingId') ?? '').trim();
  if (id === '') {
    return {
      ...INITIAL_PUBLICATION_STATE,
      status: 'error',
      message: 'That listing could not be identified. Reload the page and try again.',
    };
  }

  const { getToken } = await auth();
  const outcome = await publishListing(
    webEnv().API_BASE_URL,
    await getToken(),
    id,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      // The page is a server component reading the listing, so it has to be told
      // the row changed. Without this the owner presses Publish, the request
      // succeeds, and the page redraws from cache still saying "Draft" — which
      // reads exactly like a button that does nothing.
      revalidatePath(listingPath(id));
      return { ...INITIAL_PUBLICATION_STATE, status: 'idle' };

    case 'not-ready':
      return {
        status: 'not-ready',
        message: 'This listing is not ready to be published yet.',
        blockers: outcome.blockers,
      };

    case 'not-found':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: 'That listing no longer exists.',
      };

    case 'forbidden':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message:
          'You cannot publish while your account is suspended. You can still read ' +
          'and export everything you have.',
      };

    case 'signed-out':
      /*
       * **The state first, the likeliest cause second** — the wording
       * `listings/new/actions.ts` settled on, for the reason recorded there:
       * "your session has expired" is a claim about a session we cannot vouch
       * for, and it was being shown to people who had never had one.
       *
       * **The trailing clause names the button they pressed**, because the two
       * actions in this file are not interchangeable and a generic "try once
       * more" would leave somebody wondering whether a half-published listing
       * is now visible to strangers. It says what is visible rather than what
       * the status is: this control also *resumes* a paused listing, so
       * "it is still a draft" would be wrong half the time — but both states
       * it can be pressed from are ones nobody else can see.
       */
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message:
          'You are not signed in, so this listing was not published and nobody ' +
          'else can see it. Your session may have expired — sign in again and ' +
          'publish it once more.',
      };

    case 'invalid':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: outcome.issues.join('; '),
      };

    case 'unavailable':
      /*
       * The API's own sentence, verbatim and with no prefix (slice H3a).
       *
       * **Not `That did not complete — …`**, which is the wording for the cases
       * below and would be wrong here twice: it reads as a fault, and it reads
       * as uncertainty about whether anything happened. Neither is true — the
       * platform refused deliberately, the listing is untouched, and the API
       * already says so in a sentence written for the person reading it.
       */
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: outcome.reason,
      };

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: `That did not complete — ${outcome.reason}`,
      };
  }
}

/**
 * Pausing a listing (§8.3, slice 2.8b).
 *
 * The mirror of `publishListingAction`, and deliberately shorter: pausing has no
 * completeness rules to fail, no platform switch to be refused by, and nothing
 * typed into a form that could be wrong. What is left is the id, the request,
 * and the two ways it can be refused — the listing is not theirs, or it was
 * never published.
 *
 * **Reuses `PublicationActionState`** rather than adding a second shape. Both
 * controls sit in the same region of the same page and only one can be pressed
 * at a time; two states would let the page hold a stale refusal from the other
 * button while showing this one's outcome.
 */
export async function pauseListingAction(
  _previous: PublicationActionState,
  form: FormData,
): Promise<PublicationActionState> {
  const id = String(form.get('listingId') ?? '').trim();
  if (id === '') {
    return {
      ...INITIAL_PUBLICATION_STATE,
      status: 'error',
      message: 'That listing could not be identified. Reload the page and try again.',
    };
  }

  const { getToken } = await auth();
  const outcome = await pauseListing(
    webEnv().API_BASE_URL,
    await getToken(),
    id,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      // The page is a server component, so it has to be told the row changed.
      // Without this the owner presses Pause, the request succeeds, and the page
      // redraws from cache still saying Published — the defect 2.8a found on the
      // other button.
      revalidatePath(listingPath(id));
      return { ...INITIAL_PUBLICATION_STATE, status: 'idle' };

    case 'refused':
      /*
       * The API's own sentence, verbatim and unprefixed — `unavailable`'s
       * treatment on the publish action, for the same two reasons. It is not a
       * fault, and there is no uncertainty about whether anything happened: the
       * listing is exactly as it was and the API has said why in words written
       * for the person reading them.
       */
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: outcome.reason,
      };

    case 'not-found':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: 'That listing no longer exists.',
      };

    case 'forbidden':
      /*
       * Reachable only if the suspension rule changes, because ADR 0024 lets a
       * suspended owner pause — taking a listing down makes strangers see less.
       * Kept rather than folded into the generic branch: if somebody ever
       * removes `@AllowsSuspended()` from the route, this is the difference
       * between an explanation and "API answered 403".
       */
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: 'You cannot change this listing while your account is suspended.',
      };

    case 'signed-out':
      /*
       * **The mirror of the publish action's, and the trailing clause is the
       * half that had to change.** The refusal is identical; what it leaves
       * behind is the opposite. Somebody who pressed Pause wanted their listing
       * off the public site, so the fact they need first is that it is still
       * on it — telling them only to sign in again would let them walk away
       * believing an item they cannot lend is no longer being offered.
       *
       * **"Still published" rather than "still public"**: this control only
       * renders on a `PUBLISHED` listing, but a published listing an
       * administrator has hidden is not visible to anybody, and the stronger
       * word would be a claim about moderation state this action never reads.
       */
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message:
          'You are not signed in, so this listing was not paused and is still ' +
          'published. Your session may have expired — sign in again and pause ' +
          'it once more.',
      };

    case 'invalid':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: outcome.issues.join('; '),
      };

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: `That did not complete — ${outcome.reason}`,
      };
  }
}
