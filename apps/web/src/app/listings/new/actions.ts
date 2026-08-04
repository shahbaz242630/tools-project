'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listingDraftSchema, listingPath } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { readReplacementValue } from '../../../lib/replacement-value';
import { createListing } from '../../../lib/listings';
import { webEnv } from '../../../lib/env';
import { INITIAL_LISTING_STATE } from './state';
import type { ListingActionState } from './state';

/**
 * Creating a draft listing.
 *
 * Validated here *and* by the API, and the API's answer is the one that counts.
 * The check here exists so that a round trip to be told "title: must be at least
 * 3 characters" is not how somebody finds out.
 *
 * **The state and its initial value live in `state.ts`, not here.** A
 * `'use server'` file may export only async functions; an exported object makes
 * the route's generated action loader throw *"A 'use server' file can only
 * export async functions, found object"* — and it throws when the action is
 * *invoked*, not when the page renders, so the form looks fine until somebody
 * presses the button.
 */

export async function createListingAction(
  _previous: ListingActionState,
  form: FormData,
): Promise<ListingActionState> {
  const categorySlug = String(form.get('categorySlug') ?? '').trim();
  const title = String(form.get('title') ?? '').trim();
  const description = String(form.get('description') ?? '');
  const replacementValue = String(form.get('replacementValue') ?? '');
  const typed = { categorySlug, title, description, replacementValue };

  // Pounds on the form, pence in the contract — and a string the whole way, so
  // no float ever exists (ADR 0002). See `readReplacementValue`.
  const value = readReplacementValue(replacementValue);
  if (!value.ok) {
    return {
      ...INITIAL_LISTING_STATE,
      ...typed,
      status: 'error',
      message: value.message,
    };
  }

  // The contract's own schema, not a second opinion about what a title is. A
  // separate rule here would drift from the one the API enforces, and the
  // divergence would surface as a form that accepts what the API rejects.
  const parsed = listingDraftSchema.safeParse({
    categorySlug,
    title,
    description,
    replacementValue: value.value,
  });
  if (!parsed.success) {
    return {
      ...INITIAL_LISTING_STATE,
      ...typed,
      status: 'error',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  const { getToken } = await auth();
  const outcome = await createListing(
    webEnv().API_BASE_URL,
    await getToken(),
    parsed.data,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      // Outside the switch would be tidier and would not work: `redirect`
      // throws a control-flow signal, so it must not sit inside the try/catch
      // any refactor might wrap this in.
      break;

    case 'invalid':
      return {
        ...INITIAL_LISTING_STATE,
        ...typed,
        status: 'error',
        message: outcome.issues.join('; '),
      };

    case 'not-found':
      return {
        ...INITIAL_LISTING_STATE,
        ...typed,
        status: 'error',
        message:
          'That category is no longer available. Choose another — the list may have ' +
          'changed since this page was opened.',
      };

    case 'forbidden':
      return {
        ...INITIAL_LISTING_STATE,
        ...typed,
        status: 'error',
        message:
          'Your account cannot create listings at the moment. If it has been ' +
          'suspended, the reason is on your account page.',
      };

    case 'signed-out':
      return {
        ...INITIAL_LISTING_STATE,
        ...typed,
        status: 'error',
        message: 'Your session has expired. Sign in again.',
      };

    case 'unreachable':
    case 'malformed':
      return {
        ...INITIAL_LISTING_STATE,
        ...typed,
        status: 'error',
        message: `That did not save — ${outcome.reason}`,
      };
  }

  redirect(listingPath(outcome.value.id));
}
