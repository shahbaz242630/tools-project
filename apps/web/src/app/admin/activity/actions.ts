'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';

import { clientIpFrom } from '../../../lib/client-ip';
import { fetchAdminActivity } from '../../../lib/admin-activity';
import { webEnv } from '../../../lib/env';
import { INITIAL_ADMIN_LOOKUP_STATE } from './state';
import type { AdminLookupState } from './state';

export async function lookUpActivityAction(
  _previous: AdminLookupState,
  form: FormData,
): Promise<AdminLookupState> {
  const userId = String(form.get('userId') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  const typed = { userId, reason };

  if (userId === '') {
    return {
      ...INITIAL_ADMIN_LOOKUP_STATE,
      ...typed,
      status: 'error',
      message: 'Enter the account id to look up.',
    };
  }

  if (reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      ...INITIAL_ADMIN_LOOKUP_STATE,
      ...typed,
      status: 'error',
      message: `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. It is recorded against the account you are viewing, and they can read it.`,
    };
  }

  const { getToken } = await auth();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchAdminActivity(
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
        ...INITIAL_ADMIN_LOOKUP_STATE,
        ...typed,
        status: 'loaded',
        entries: outcome.entries,
      };

    case 'forbidden':
      // Distinct from signed out, because the remedy differs: this person is
      // authenticated and either lacks the role or needs to verify a second
      // factor. Saying which would help somebody probing; saying neither would
      // leave a legitimate administrator stuck.
      return {
        ...INITIAL_ADMIN_LOOKUP_STATE,
        ...typed,
        status: 'error',
        message:
          'You do not have access to this. Administrator access needs a second ' +
          'factor verified recently — sign in again with it if you have one.',
      };

    case 'signed-out':
      return {
        ...INITIAL_ADMIN_LOOKUP_STATE,
        ...typed,
        status: 'error',
        message: 'Your session has expired. Sign in again.',
      };

    case 'invalid':
      return {
        ...INITIAL_ADMIN_LOOKUP_STATE,
        ...typed,
        status: 'error',
        message: outcome.issues.join('; '),
      };

    case 'unreachable':
    case 'malformed':
      return {
        ...INITIAL_ADMIN_LOOKUP_STATE,
        ...typed,
        status: 'error',
        message: `The lookup did not complete — ${outcome.reason}`,
      };
  }
}
