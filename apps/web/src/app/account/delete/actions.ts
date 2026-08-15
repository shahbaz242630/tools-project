'use server';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { clientIpFrom } from '../../../lib/client-ip';
import { requestDeletion } from '../../../lib/deletion';
import { webEnv } from '../../../lib/env';

import type { DeletionOutcome } from '../../../lib/deletion';
import type { DeletionFormState } from './state';

/** Typed so a missing confirmation is a state, not an exception. */
export async function deleteAccountAction(
  _previous: DeletionFormState,
  form: FormData,
): Promise<DeletionFormState> {
  // An explicit, typed confirmation rather than a checkbox. There is no undo
  // and no grace period, so the cost of an accidental submit is total — making
  // somebody type the word is proportionate to that.
  const confirmation = form.get('confirmation');
  if (
    typeof confirmation !== 'string' ||
    confirmation.trim().toUpperCase() !== 'DELETE'
  ) {
    return {
      status: 'error',
      message: 'Type DELETE to confirm. Nothing has been changed.',
      credentialRemains: false,
    };
  }

  const { getToken, userId } = await auth();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await requestDeletion(
    webEnv().API_BASE_URL,
    await getToken(),
    undefined,
    clientIp,
  );

  /*
   * **The success path is entered by a positive test, never by falling out of
   * one.** This read `if (signed-out) … if (uncertain) … else it worked`, which
   * is the same sentence with the safety inverted: every outcome the chain did
   * not name — including every outcome a later version of `lib/deletion.ts`
   * might add — arrived at the bottom and was reported as a completed deletion.
   *
   * A `switch` with a `break` on `deleted` would read better and would restore
   * exactly that defect, because an unmatched `switch` also falls to the code
   * below. So the guard is the guard, and `refusal` holds every other answer.
   */
  if (outcome.kind !== 'deleted') return refusal(outcome);

  // Our side is done. Everything from here is best effort, and its failure must
  // not be reported as the deletion failing.
  if (userId === null) {
    return { status: 'deleted', message: null, credentialRemains: true };
  }

  try {
    const clerk = await clerkClient();
    await clerk.users.deleteUser(userId);
  } catch {
    // The account is already erased and locked out on our side — the guard
    // refuses its sessions — so a surviving credential cannot reach anything.
    // Clerk's own `user.deleted` webhook is not coming, but the mirror is
    // already in the state that webhook would produce.
    return { status: 'deleted', message: null, credentialRemains: true };
  }

  return { status: 'deleted', message: null, credentialRemains: false };
}

/**
 * Everything that is not a confirmed deletion.
 *
 * **The `default` is the load-bearing part and it is not defensive padding.**
 * `outcome` is narrowed to `never` there, so a new member of `DeletionOutcome`
 * makes the assignment a compile error — which is how the wording for it gets
 * written rather than defaulted. And if one ever reaches here at runtime anyway,
 * from a version skew or a value the type system never saw, the answer is still
 * a refusal. Compile-time exhaustiveness and a fail-closed runtime are usually
 * presented as alternatives; on this path we need both, because the failure mode
 * of getting it wrong is telling somebody their data is gone when it is not.
 */
function refusal(
  outcome: Exclude<DeletionOutcome, { kind: 'deleted' }>,
): DeletionFormState {
  switch (outcome.kind) {
    case 'signed-out':
      /*
       * **The state first, the likeliest cause second**, as everywhere else —
       * "your session has expired" is a claim about a session we cannot vouch
       * for. But this branch carries a second obligation the others do not.
       *
       * **It must say outright that nothing was deleted.** The `uncertain`
       * branch below exists precisely because a write we cannot confirm must
       * not be reported as a failure; the inverse holds here. This *is* a
       * confirmed failure — the API refused the token before touching anything
       * — and the person reading it has just typed DELETE. Ambiguity about
       * which of those two branches they are in is the difference between an
       * account they still have and one they believe is gone, and they cannot
       * check by signing in: being unable to sign in is what the `uncertain`
       * message tells them the deletion *succeeded* looks like.
       */
      return {
        status: 'error',
        message:
          'You are not signed in, so nothing was deleted — your account and ' +
          'everything in it are exactly as they were. Your session may have ' +
          'expired; sign in again and confirm once more if you still want to ' +
          'delete it.',
        credentialRemains: false,
      };

    case 'forbidden':
      /*
       * As certain as the branch above, and worded to match it: a 403 is the
       * guard refusing before anything is touched, so "nothing was deleted" is
       * a fact rather than a hope. What it must *not* borrow from `uncertain`
       * is the invitation to sign in and check — this person can sign in, and
       * doing so would show them an intact account and explain nothing.
       *
       * The reason an administrator wrote is on the account page, verbatim,
       * which is where this sends them rather than repeating it here.
       */
      return {
        status: 'error',
        message:
          'Your account was not deleted, and nothing in it has been changed. ' +
          'The request was refused rather than lost, so confirming again will ' +
          'not change it. If your account has been suspended, the reason is on ' +
          'your account page.',
        credentialRemains: false,
      };

    case 'uncertain':
      // Deliberately not "it failed". A timeout on a write is not evidence that
      // nothing happened, and somebody told it failed will try again — by which
      // point they may not be able to authenticate to try.
      return {
        status: 'error',
        message:
          `We could not confirm whether your account was deleted — ${outcome.reason}. ` +
          'Sign in again to check: if you cannot, the deletion went through.',
        credentialRemains: false,
      };

    default: {
      const unrecognised: never = outcome;
      void unrecognised;
      return {
        status: 'error',
        message:
          'We could not confirm whether your account was deleted. Sign in ' +
          'again to check: if you cannot, the deletion went through.',
        credentialRemains: false,
      };
    }
  }
}
