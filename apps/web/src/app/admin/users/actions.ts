'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';

import { clientIpFrom } from '../../../lib/client-ip';
import { fetchAdminUser } from '../../../lib/admin-user';
import { decideSuspension } from '../../../lib/admin-approvals';
import { webEnv } from '../../../lib/env';
import { INITIAL_ADMIN_USER_STATE } from './state';
import type { AdminUserLookupState, SuspensionActionState } from './state';

export async function lookUpAccountAction(
  _previous: AdminUserLookupState,
  form: FormData,
): Promise<AdminUserLookupState> {
  const userId = String(form.get('userId') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  const typed = { userId, reason };

  if (userId === '') {
    return {
      ...INITIAL_ADMIN_USER_STATE,
      ...typed,
      status: 'error',
      message: 'Enter the account id to look up.',
    };
  }

  if (reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      ...INITIAL_ADMIN_USER_STATE,
      ...typed,
      status: 'error',
      message: `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. It is recorded against the account you are viewing, and they can read it.`,
    };
  }

  const { getToken } = await auth();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchAdminUser(
    webEnv().API_BASE_URL,
    await getToken(),
    userId,
    reason,
    undefined,
    clientIp,
  );

  switch (outcome.kind) {
    case 'loaded':
      return {
        ...INITIAL_ADMIN_USER_STATE,
        ...typed,
        status: 'loaded',
        view: outcome.view,
      };

    case 'not-found':
      // The lookup still happened and is still recorded — an administrator
      // asking after an id is a real event. Saying so plainly avoids somebody
      // retyping a correct id on the belief that the page failed.
      return {
        ...INITIAL_ADMIN_USER_STATE,
        ...typed,
        status: 'error',
        message:
          'No account with that id. The lookup is still recorded, because you asked.',
      };

    case 'forbidden':
      // Distinct from signed out, because the remedy differs: this person is
      // authenticated and either lacks the role or needs to verify a second
      // factor. Saying which would help somebody probing; saying neither would
      // leave a legitimate administrator stuck.
      return {
        ...INITIAL_ADMIN_USER_STATE,
        ...typed,
        status: 'error',
        message:
          'You do not have access to this. Administrator access needs a second ' +
          'factor verified recently — sign in again with it if you have one.',
      };

    case 'signed-out':
      return {
        ...INITIAL_ADMIN_USER_STATE,
        ...typed,
        status: 'error',
        // The state first, the likeliest cause second — see the note in
        // `admin/approvals/actions.ts`.
        message:
          'You are not signed in. Your session may have expired — sign in again ' +
          'and try once more.',
      };

    case 'invalid':
      return {
        ...INITIAL_ADMIN_USER_STATE,
        ...typed,
        status: 'error',
        message: outcome.issues.join('; '),
      };

    case 'unreachable':
    case 'malformed':
      return {
        ...INITIAL_ADMIN_USER_STATE,
        ...typed,
        status: 'error',
        message: `The lookup did not complete — ${outcome.reason}`,
      };
  }
}

export async function decideSuspensionAction(
  _previous: SuspensionActionState,
  form: FormData,
): Promise<SuspensionActionState> {
  const userId = String(form.get('userId') ?? '').trim();
  const decision = form.get('decision') === 'reinstate' ? 'reinstate' : 'suspend';
  const reason = String(form.get('reason') ?? '').trim();

  if (reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      status: 'error',
      reason,
      message: `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. The account holder reads this, so write something you would say to them.`,
    };
  }

  const { getToken } = await auth();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await decideSuspension(
    webEnv().API_BASE_URL,
    await getToken(),
    userId,
    decision,
    reason,
    undefined,
    clientIp,
  );

  switch (outcome.kind) {
    case 'loaded':
      return {
        status: 'done',
        reason,
        message:
          decision === 'suspend'
            ? 'Suspended. They can still sign in to read and download their data, and to delete the account.'
            : 'Reinstated. The account works normally again.',
      };

    case 'refused':
      // The request was fine and the state of the world refused it — already
      // suspended, yourself, the last administrator. Retyping will not help.
      return { status: 'error', reason, message: outcome.reason };

    case 'invalid':
      return { status: 'error', reason, message: outcome.issues.join('; ') };

    case 'not-found':
      return { status: 'error', reason, message: 'No account with that id.' };

    case 'forbidden':
      return {
        status: 'error',
        reason,
        message:
          'You do not have access to this. Administrator access needs a second ' +
          'factor verified recently — sign in again with it if you have one.',
      };

    case 'signed-out':
      return {
        status: 'error',
        reason,
        // The state first, the likeliest cause second — see the note in
        // `admin/approvals/actions.ts`.
        message:
          'You are not signed in. Your session may have expired — sign in again ' +
          'and try once more.',
      };

    case 'unreachable':
    case 'malformed':
      return {
        status: 'error',
        reason,
        message: `That did not complete — ${outcome.reason}`,
      };
  }
}
