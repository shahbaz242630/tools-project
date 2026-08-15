'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listingEditSchema, listingPath } from '@platform/contracts';
import type { TransportRequirement } from '@platform/contracts';
import { clientIpFrom } from '../../../../lib/client-ip';
import { readCollectionLocation } from '../../../../lib/collection-location';
import { asSentences } from '../../../../lib/contract-issues';
import { describeIncompleteRefusal } from '../../../../lib/incomplete-refusal';
import { readRateCard } from '../../../../lib/rate-card';
import { readReplacementValue } from '../../../../lib/replacement-value';
import { readSubmittedAttributes } from '../../../../lib/submitted-attributes';
import { updateListing } from '../../../../lib/listings';
import { webEnv } from '../../../../lib/env';
import type { ListingEditState } from './state';

/**
 * Saving an edit (slice 2.9b-i, ADR 0042).
 *
 * The create action's shape, minus the category and the address, and the
 * parallels are deliberate: an owner correcting a listing meets the same
 * validation, the same stale-category race and the same refusals as one writing
 * a new one, so two actions explaining them differently would be two vocabularies
 * for one thing.
 *
 * **The listing id is bound, not posted.** `editListingAction.bind(null, id)`
 * makes it an argument the form cannot carry, where a hidden input would be a
 * value a caller may change. The API refuses somebody else's listing regardless
 * — ownership is in the query — so this is the second lock rather than the only
 * one, which is the right way round.
 */

/** Whatever was chosen, unvalidated — the contract below is what decides. */
function readTransportRequirement(form: FormData): TransportRequirement | null {
  const chosen = String(form.get('transportRequirement') ?? '').trim();
  return chosen === '' ? null : (chosen as TransportRequirement);
}

export async function editListingAction(
  listingId: string,
  previous: ListingEditState,
  form: FormData,
): Promise<ListingEditState> {
  const title = String(form.get('title') ?? '').trim();
  const description = String(form.get('description') ?? '');
  const replacementValue = String(form.get('replacementValue') ?? '');
  const dailyRate = String(form.get('dailyRate') ?? '');
  const weekendRate = String(form.get('weekendRate') ?? '');
  const weeklyRate = String(form.get('weeklyRate') ?? '');
  // Untrimmed here and trimmed inside `readCollectionLocation`, matching the
  // create action: the decision about what "blank" means belongs in one place,
  // and it is not the same as "empty after trimming every field separately".
  const line1 = String(form.get('line1') ?? '');
  const line2 = String(form.get('line2') ?? '');
  const town = String(form.get('town') ?? '');
  const postcode = String(form.get('postcode') ?? '');

  /*
   * **Spread over `previous` rather than over a blank initial state**, and this
   * is the one place the edit action genuinely differs from the create action
   * rather than merely being smaller.
   *
   * The create form falls back to `INITIAL_LISTING_STATE`, whose fields are all
   * empty — correct there, because an empty create form is where somebody
   * started. Here the fallback is the listing as it stands, so a field that
   * somehow did not come back in the POST shows what is saved rather than
   * blanking. `typed` still wins for everything that did arrive.
   */
  const typed = {
    title,
    description,
    replacementValue,
    dailyRate,
    weekendRate,
    weeklyRate,
    line1,
    line2,
    town,
    postcode,
  };
  const refused = (message: string): ListingEditState => ({
    ...previous,
    ...typed,
    status: 'error',
    message,
  });

  const attributes = readSubmittedAttributes(form.get('attributes'));
  if (!attributes.ok) return refused(attributes.message);

  const categoryVersionNumber = Number(form.get('categoryVersionNumber') ?? '');
  if (!Number.isInteger(categoryVersionNumber) || categoryVersionNumber < 1) {
    // Unreachable from the form, which renders it as a hidden input from the
    // category the page read. Refused rather than defaulted, because the value
    // it would default to is "whatever is current", which is precisely the
    // assumption that makes the stale-form race invisible (ADR 0029).
    return refused('This page is out of date. Reload it and try again.');
  }

  const value = readReplacementValue(replacementValue);
  if (!value.ok) return refused(value.message);

  const rates = readRateCard({
    daily: dailyRate,
    weekend: weekendRate,
    weekly: weeklyRate,
  });
  if (!rates.ok) return refused(rates.message);

  // All four blank is a real answer — the owner is removing the address — and a
  // *partly* filled one is somebody mid-edit, refused rather than silently read
  // as blank. The same rule the create form uses, and the same module, because
  // two readings of "blank" is how one of them ends up discarding an address.
  const location = readCollectionLocation({ line1, line2, town, postcode });
  if (!location.ok) return refused(location.message);

  // Checked here *and* by the API, and the API's answer is the one that counts.
  // This exists so that a round trip is not how somebody finds out their title
  // is two characters short.
  const parsed = listingEditSchema.safeParse({
    title,
    description,
    replacementValue: value.value,
    categoryVersionNumber,
    attributes: attributes.value,
    transportRequirement: readTransportRequirement(form),
    requiresTwoPersonLift: form.get('requiresTwoPersonLift') === 'on',
    rates: rates.value,
    collectionLocation: location.value,
  });
  if (!parsed.success) return refused(asSentences(parsed.error.issues));

  const outcome = await updateListing(
    webEnv().API_BASE_URL,
    await (await auth()).getToken(),
    listingId,
    parsed.data,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      // Outside the switch, because `redirect` throws a control-flow signal and
      // must not sit inside a try/catch a later refactor might wrap this in.
      break;

    case 'invalid':
      return refused(outcome.issues.join('; '));

    case 'not-found':
      // The listing, not the category — this route names one and carries no
      // category at all. It is what a stranger's listing answers, and what a
      // listing deleted in another tab answers.
      return refused(
        'That listing could not be found. It may have been deleted — check your ' +
          'listings.',
      );

    case 'forbidden':
      return refused(
        'Your account cannot change listings at the moment. If it has been ' +
          'suspended, the reason is on your account page.',
      );

    case 'signed-out':
      /*
       * **The state first, the likeliest cause second**, as in
       * `listings/new/actions.ts` — "your session has expired" is a claim about
       * a session we cannot vouch for, and it was being shown to people who had
       * never had one.
       *
       * **The last clause is a promise `refused` keeps.** It spreads `typed`
       * over `previous`, so every field comes back with what was in it; an edit
       * refused this way loses nothing, and somebody who is not told that will
       * assume it did and copy their text out before signing in.
       */
      return refused(
        'You are not signed in, so nothing was saved. Your session may have ' +
          'expired — sign in again and save once more; everything you typed is ' +
          'still here.',
      );

    case 'stale-category':
      /*
       * **This case exists on an edit only because of ADR 0042.** Before it, an
       * edit revalidated against the version the listing had already pinned — a
       * row a trigger refuses to update, so it could not go stale and this
       * branch would have been unreachable. Now editing brings the listing onto
       * the *current* version, so the form can be built from configuration an
       * administrator replaces while it sits open.
       *
       * Nothing they typed is wrong, which is why this does not read as a
       * validation failure.
       */
      return refused(
        'This category was changed while you were editing, so the details it asks ' +
          'for may be different now. Reload the page and check the ' +
          'category-specific fields — everything else you typed is still here.',
      );

    case 'incomplete':
      /*
       * **The listing is published and this save would break it** (slice
       * 2.9b-ii). Every other refusal here is about the request; this one is
       * about what the listing would become, and the only two ways out are to put
       * the missing thing back or to pause the listing first.
       *
       * The blockers are turned into their sentences rather than shown as a
       * checklist, which the publish page does instead. The difference is that
       * somebody publishing is working through a list on purpose, and somebody
       * editing has hit one thing they did not expect — a list of one item
       * rendered as a checklist reads like a form they have failed.
       */
      return refused(describeIncompleteRefusal(outcome.blockers));

    case 'unreachable':
    case 'malformed':
      return refused(`That did not save — ${outcome.reason}`);
  }

  redirect(listingPath(listingId));
}
