'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import {
  MIN_ADMIN_REASON_LENGTH,
  MODERATION_STATES,
  moderationRequiresReason,
} from '@platform/contracts';
import type { ModerationState } from '@platform/contracts';

import { clientIpFrom } from '../../../lib/client-ip';
import { moderateListing } from '../../../lib/admin-listings';
import { webEnv } from '../../../lib/env';
import { INITIAL_MODERATION_STATE } from './state';
import type { ModerationActionState } from './state';

/**
 * The decision, as somebody submitted it.
 *
 * **Read from the form rather than trusted from it.** `state` arrives as a
 * string from a radio group and could be anything at all; the API would refuse
 * an unknown value with a 400, but the message it produced would name a contract
 * path rather than tell a moderator what happened. Narrowing here means the one
 * case that cannot be explained usefully never leaves the browser.
 */
function readState(raw: unknown): ModerationState | null {
  return MODERATION_STATES.find((state) => state === raw) ?? null;
}

/**
 * Record what the platform permits of a listing (§8.3, §9, ADR 0041).
 *
 * **The three checks below duplicate the API's, on purpose and in the same
 * direction.** The API is the authority — it refuses a missing reason, a short
 * one and an unknown state — and this exists so nobody is *told* a decision was
 * accepted-then-refused for something the form could see. That is the defect
 * H3b fixed on the publish button, and the rule it left behind: a control must
 * not offer what the thing behind it will refuse.
 *
 * They are deliberately not *stricter* than the API. A form that refuses what
 * the platform would accept is the same defect pointing the other way, and it is
 * the harder of the two to notice.
 */
export async function moderateListingAction(
  _previous: ModerationActionState,
  form: FormData,
): Promise<ModerationActionState> {
  const listingId = String(form.get('listingId') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  const state = readState(form.get('state'));
  const typed = { listingId, reason };

  if (listingId === '') {
    return {
      ...INITIAL_MODERATION_STATE,
      ...typed,
      status: 'error',
      message: 'Enter the id of the listing you are deciding about.',
    };
  }

  if (state === null) {
    return {
      ...INITIAL_MODERATION_STATE,
      ...typed,
      status: 'error',
      message: 'Choose what the platform should permit of this listing.',
    };
  }

  /*
   * Whether a reason is owed, and whether the one given is long enough, are two
   * different questions and the messages differ accordingly.
   *
   * `moderationRequiresReason` is the contract's own function rather than a
   * comparison written here, so a fourth state added later inherits the answer
   * instead of defaulting to needing no explanation — which is the direction
   * that lets a listing vanish without one.
   */
  if (moderationRequiresReason(state) && reason === '') {
    return {
      ...INITIAL_MODERATION_STATE,
      ...typed,
      status: 'error',
      message:
        'Give a reason. This takes somebody’s listing out of public view, and the ' +
        'reason is what they are owed and what the audit trail carries.',
    };
  }

  if (reason !== '' && reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      ...INITIAL_MODERATION_STATE,
      ...typed,
      status: 'error',
      message: `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters, or none at all if you are reinstating.`,
    };
  }

  const { getToken } = await auth();
  const outcome = await moderateListing(
    webEnv().API_BASE_URL,
    await getToken(),
    listingId,
    state,
    // Blank becomes absent, so "no reason" has one representation on the wire as
    // well as in the database.
    reason === '' ? null : reason,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      return {
        ...INITIAL_MODERATION_STATE,
        listingId,
        // Cleared on success so the next decision needs its own reason. One
        // carried over from a previous listing would be a lie in the trail.
        reason: '',
        status: 'done',
        recorded: outcome.value.moderationState,
        message: describeDecision(outcome.value.moderationState),
      };

    case 'invalid':
      return {
        ...INITIAL_MODERATION_STATE,
        ...typed,
        status: 'error',
        message: outcome.issues.join('; '),
      };

    case 'not-found':
      return {
        ...INITIAL_MODERATION_STATE,
        ...typed,
        status: 'error',
        message:
          'No listing with that id. Nothing was changed — check the id you were ' +
          'given rather than trying again.',
      };

    case 'forbidden':
      return {
        ...INITIAL_MODERATION_STATE,
        ...typed,
        status: 'error',
        message:
          'You do not have access to this. Administrator access needs a second ' +
          'factor verified recently — sign in again with it if you have one.',
      };

    case 'signed-out':
      return {
        ...INITIAL_MODERATION_STATE,
        ...typed,
        status: 'error',
        message: 'Your session has expired. Sign in again.',
      };

    case 'unreachable':
    case 'malformed':
      // Explicit that nothing changed. Somebody who has just tried to take a
      // listing out of public view needs to know whether they succeeded, and
      // "that did not complete" alone does not say.
      return {
        ...INITIAL_MODERATION_STATE,
        ...typed,
        status: 'error',
        message: `That did not complete and nothing was changed — ${outcome.reason}`,
      };
  }
}

/**
 * What each recorded decision means, in the words of its consequence.
 *
 * An exhaustive `switch` rather than a lookup with a fallback, which is the fix
 * 2.8b arrived at after a binary status line reinstated a bug it had already
 * fixed: a fourth state added to the vocabulary fails to compile here instead of
 * quietly rendering as whichever branch was written last.
 *
 * **Every sentence says what the owner's own intent still is**, because that is
 * the thing ADR 0041 makes true and the thing a moderator will otherwise assume
 * wrong. Hiding a listing does not unpublish it; approving one does not publish
 * it.
 */
function describeDecision(state: ModerationState): string {
  switch (state) {
    case 'UNDER_REVIEW':
      return (
        'Recorded — under review, and out of public view while it is. What the ' +
        'owner set is untouched: if they had it published it is still published, ' +
        'and it goes back to being visible when you approve it.'
      );

    case 'REJECTED':
      return (
        'Recorded — refused, and out of public view. What the owner set is ' +
        'untouched, so approving it later puts it back exactly as they had it.'
      );

    case 'APPROVED':
      return (
        'Recorded — nothing is holding it back. It is visible again only if its ' +
        'owner had it published; if they had paused it, it stays paused, because ' +
        'that is their decision and not yours.'
      );
  }
}
