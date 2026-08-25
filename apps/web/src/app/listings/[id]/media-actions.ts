'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { clientIpFrom } from '../../../lib/client-ip';
import { ownerListingPath } from '../../../lib/page-paths';
import { deleteListingMedia, reorderListingMedia } from '../../../lib/listing-media';
import type { MediaOutcome } from '../../../lib/listing-media';
import { webEnv } from '../../../lib/env';
import { INITIAL_MEDIA_STATE } from './media-state';
import type { MediaActionState } from './media-state';

/**
 * Removing and reordering photographs (slice 2.6c).
 *
 * **Server actions, while the upload beside them is a route handler**, and the
 * split is not inconsistency. A body cap of 1 MB is the reason the upload cannot
 * be an action; a delete carries two ids and a reorder carries at most ten, so
 * both sit far inside it and get the thing an action gives that a route handler
 * does not — `revalidatePath`, and a form that works the way every other form on
 * this page does.
 *
 * **The state and its initial value live in `media-state.ts`.** A `'use server'`
 * file may export only async functions (slice 2.4a).
 */

/** Remove one photograph. */
export async function deleteMediaAction(
  _previous: MediaActionState,
  form: FormData,
): Promise<MediaActionState> {
  const listingId = String(form.get('listingId') ?? '').trim();
  const mediaId = String(form.get('mediaId') ?? '').trim();

  if (listingId === '' || mediaId === '') {
    return {
      status: 'error',
      message:
        'That photograph could not be identified. Reload the page and try again.',
    };
  }

  const { getToken } = await auth();
  const outcome = await deleteListingMedia(
    webEnv().API_BASE_URL,
    await getToken(),
    listingId,
    mediaId,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  return settle(outcome, listingId, {
    /*
     * **404 is reported as success, and that is deliberate** rather than a
     * swallowed error. The owner asked for this photograph to be gone; if it is
     * already gone — a second tab deleted it, or the button was pressed twice —
     * then the state they asked for is the state that holds. Reporting "that
     * photograph no longer exists" would be technically true and useless: it
     * describes a failure to do something that does not need doing.
     *
     * It is confined to *delete* for that reason and is not a general rule. A
     * reorder answering 404 has genuinely failed.
     */
    notFoundIsSuccess: true,
    failed: 'That photograph could not be removed',
  });
}

/**
 * Put them in a given order.
 *
 * **The whole list travels, not a move instruction** — the contract's shape, and
 * the reason is two open tabs producing an order neither person asked for.
 */
export async function reorderMediaAction(
  _previous: MediaActionState,
  form: FormData,
): Promise<MediaActionState> {
  const listingId = String(form.get('listingId') ?? '').trim();
  /*
   * **`getAll`, not a comma-joined string.** The control submits one hidden
   * field per photograph, so the order is carried by the form rather than
   * re-encoded into a single value that would then need splitting, trimming and
   * defending against an id containing the separator.
   */
  const mediaIds = form
    .getAll('mediaIds')
    .map((value) => String(value).trim())
    .filter((value) => value !== '');

  if (listingId === '' || mediaIds.length === 0) {
    return {
      status: 'error',
      message: 'That order could not be read. Reload the page and try again.',
    };
  }

  const { getToken } = await auth();
  const outcome = await reorderListingMedia(
    webEnv().API_BASE_URL,
    await getToken(),
    listingId,
    mediaIds,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  return settle(outcome, listingId, {
    notFoundIsSuccess: false,
    failed: 'That order could not be saved',
  });
}

/**
 * One outcome mapping for both actions.
 *
 * Shared rather than written twice because the two differ in exactly two ways —
 * what a 404 means, and the clause that names what failed — and every other
 * branch is the same sentence about the same account. Two copies is how one of
 * them gains a case the other has not heard of.
 */
function settle(
  outcome: MediaOutcome<unknown>,
  listingId: string,
  { notFoundIsSuccess, failed }: { notFoundIsSuccess: boolean; failed: string },
): MediaActionState {
  switch (outcome.kind) {
    case 'loaded':
      /*
       * The page is a server component that reads the photographs, so it has to
       * be told they changed. Without this the owner presses Remove, the request
       * succeeds, and the gallery redraws from cache still showing it — which
       * reads exactly like a button that does nothing (slice 2.8a's defect).
       *
       * **A page path, never the API path.** `revalidatePath` silently does
       * nothing when handed one that matches no route — see `page-paths.ts`.
       */
      revalidatePath(ownerListingPath(listingId));
      return INITIAL_MEDIA_STATE;

    case 'not-found':
      if (notFoundIsSuccess) {
        revalidatePath(ownerListingPath(listingId));
        return INITIAL_MEDIA_STATE;
      }
      return {
        status: 'error',
        message: 'That listing no longer exists, or it is not yours.',
      };

    case 'refused':
      /*
       * **The message, not the reason.** A reorder's 422 carries the reason
       * `not-an-image`, which describes nothing true about it — the service
       * reuses that member for a stale order. The message beside it is accurate
       * ("the order must list exactly this listing's photographs, once each"),
       * so it is the message that reaches a person. The reason is for counting.
       */
      return { status: 'error', message: outcome.message };

    case 'unavailable':
      return { status: 'error', message: outcome.message };

    case 'forbidden':
      return {
        status: 'error',
        message:
          'You cannot change photographs while your account is suspended. You ' +
          'can still read and export everything you have.',
      };

    case 'signed-out':
      return {
        status: 'error',
        message:
          'You are not signed in, so nothing changed. Your session may have ' +
          'expired — sign in again and try once more.',
      };

    case 'invalid':
      return {
        status: 'error',
        message: outcome.issues[0] ?? `${failed}.`,
      };

    case 'stale-category':
    case 'malformed':
    case 'unreachable':
      return { status: 'error', message: `${failed} — ${outcome.reason}` };
  }
}
