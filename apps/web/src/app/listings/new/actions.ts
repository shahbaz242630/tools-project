'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listingDraftSchema, listingPath } from '@platform/contracts';
import type { TransportRequirement } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { readCollectionLocation } from '../../../lib/collection-location';
import { readReplacementValue } from '../../../lib/replacement-value';
import { readSubmittedAttributes } from '../../../lib/submitted-attributes';
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

/**
 * Whatever was chosen, unvalidated, with "no answer yet" read as null.
 *
 * Cast rather than checked, for the reason the category form's own reader gives:
 * the contract schema below is what decides, and a second opinion about the
 * vocabulary in this file would drift from the one the API enforces.
 */
function readTransportRequirement(form: FormData): TransportRequirement | null {
  const chosen = String(form.get('transportRequirement') ?? '').trim();
  return chosen === '' ? null : (chosen as TransportRequirement);
}

export async function createListingAction(
  _previous: ListingActionState,
  form: FormData,
): Promise<ListingActionState> {
  const categorySlug = String(form.get('categorySlug') ?? '').trim();
  const title = String(form.get('title') ?? '').trim();
  const description = String(form.get('description') ?? '');
  const replacementValue = String(form.get('replacementValue') ?? '');
  // Echoed back on every failure path below, so a refusal about a title does
  // not empty an address somebody has just typed out.
  const line1 = String(form.get('line1') ?? '');
  const line2 = String(form.get('line2') ?? '');
  const town = String(form.get('town') ?? '');
  const postcode = String(form.get('postcode') ?? '');
  const typed = {
    categorySlug,
    title,
    description,
    replacementValue,
    line1,
    line2,
    town,
    postcode,
  };

  // The category's own fields arrive as one JSON value rather than as indexed
  // field names — see the hidden input in `ListingForm`. Parsed here and
  // checked no further: which keys are legal and what shape each takes is
  // category configuration, so the only place that can decide is the API,
  // reading the schema on the version it is about to pin.
  const attributes = readSubmittedAttributes(form.get('attributes'));
  if (!attributes.ok) {
    return {
      ...INITIAL_LISTING_STATE,
      ...typed,
      status: 'error',
      message: attributes.message,
    };
  }

  const categoryVersionNumber = Number(form.get('categoryVersionNumber') ?? '');
  if (!Number.isInteger(categoryVersionNumber) || categoryVersionNumber < 1) {
    return {
      ...INITIAL_LISTING_STATE,
      ...typed,
      status: 'error',
      message: 'Choose a category before saving.',
    };
  }

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

  // All four blank is a real answer — a draft need not say where the item is
  // (§8.3). A *partly* filled address is not blank, and is refused rather than
  // dropped: see `readCollectionLocation`.
  const location = readCollectionLocation({ line1, line2, town, postcode });
  if (!location.ok) {
    return {
      ...INITIAL_LISTING_STATE,
      ...typed,
      status: 'error',
      message: location.message,
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
    categoryVersionNumber,
    attributes: attributes.value,
    // **Empty means "not said", which is null rather than the empty string.**
    // A select's "no answer yet" option posts `''`, and the contract's
    // vocabulary has no member for that — so reading it as null here is what
    // makes an unanswered draft legal (§8.3) instead of a 400 about a value
    // nobody chose.
    transportRequirement: readTransportRequirement(form),
    // A checkbox is present or absent, never `false`. Read explicitly rather
    // than by truthiness, so that the day the control changes shape this stops
    // compiling instead of quietly reading every listing as one-person.
    requiresTwoPersonLift: form.get('requiresTwoPersonLift') !== null,
    collectionLocation: location.value,
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

    case 'stale-category':
      // Nothing they typed is wrong, so this does not read as a validation
      // failure. The category was reconfigured while the page was open, which
      // means the fields below may have changed — and accepting the answers
      // anyway would have silently dropped any given to a field that has since
      // been renamed.
      return {
        ...INITIAL_LISTING_STATE,
        ...typed,
        status: 'error',
        message:
          'This category was changed while you were filling this in, so the details ' +
          'it asks for may be different now. Reload the page and check the ' +
          'category-specific fields — everything else you typed is still here.',
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
