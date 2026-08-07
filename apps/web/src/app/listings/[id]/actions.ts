'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { listingPath } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { publishListing } from '../../../lib/listings';
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
      return {
        ...INITIAL_PUBLICATION_STATE,
        status: 'error',
        message: 'Your session has expired. Sign in again.',
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
