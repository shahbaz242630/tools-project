'use server';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { clientIpFrom } from '../../../lib/client-ip';
import { requestDeletion } from '../../../lib/deletion';
import { webEnv } from '../../../lib/env';

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

  if (outcome.kind === 'signed-out') {
    /*
     * **The state first, the likeliest cause second**, as everywhere else —
     * "your session has expired" is a claim about a session we cannot vouch
     * for. But this branch carries a second obligation the others do not.
     *
     * **It must say outright that nothing was deleted.** The `uncertain` branch
     * below exists precisely because a write we cannot confirm must not be
     * reported as a failure; the inverse holds here. This *is* a confirmed
     * failure — the API refused the token before touching anything — and the
     * person reading it has just typed DELETE. Ambiguity about which of those
     * two branches they are in is the difference between an account they still
     * have and one they believe is gone, and they cannot check by signing in:
     * being unable to sign in is what the `uncertain` message tells them the
     * deletion *succeeded* looks like.
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
  }

  if (outcome.kind === 'uncertain') {
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
  }

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
