'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import type { AdminUserView } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchAdminUser } from '../../../lib/admin-user';
import { webEnv } from '../../../lib/env';

/**
 * Looking up an account, as an administrator.
 *
 * The reason is validated here *and* by the API, and the API's answer is the
 * one that counts — a check in a form is a convenience, never a control. This
 * one exists so somebody does not wait for a round trip to be told their
 * reason was too short.
 */

export interface AdminUserLookupState {
  readonly status: 'idle' | 'loaded' | 'error';
  readonly view: AdminUserView | null;
  readonly message: string | null;
  /** Kept so the form does not clear what was typed on a failure. */
  readonly userId: string;
  readonly reason: string;
}

export const INITIAL_ADMIN_USER_STATE: AdminUserLookupState = {
  status: 'idle',
  view: null,
  message: null,
  userId: '',
  reason: '',
};

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
        message: 'Your session has expired. Sign in again.',
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
