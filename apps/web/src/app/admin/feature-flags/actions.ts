'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { setFeatureFlag } from '../../../lib/admin-feature-flags';
import type { AdminFeatureFlagOutcome } from '../../../lib/admin-feature-flags';
import { webEnv } from '../../../lib/env';
import { INITIAL_FEATURE_FLAG_STATE } from './state';
import type { FeatureFlagActionState } from './state';

const REASON_HINT =
  `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. ` +
  'This changes what the platform does for everybody at once, and the reason is ' +
  'what the next person reading the incident will have to go on.';

function describe<T>(
  outcome: AdminFeatureFlagOutcome<T>,
  done: string,
): { status: 'done' | 'error'; message: string } {
  switch (outcome.kind) {
    case 'loaded':
      return { status: 'done', message: done };

    case 'invalid':
      return { status: 'error', message: outcome.issues.join('; ') };

    case 'not-found':
      // Not "no such row". A key with no override is perfectly normal — this
      // means the *build* does not declare it, which happens when a deploy
      // removes a flag while somebody has the page open.
      return {
        status: 'error',
        message:
          'This build no longer has that switch. Reload the page — it was ' +
          'probably removed by a deployment.',
      };

    case 'forbidden':
      return {
        status: 'error',
        message:
          'You do not have access to this. Administrator access needs a second ' +
          'factor verified recently — sign in again with it if you have one.',
      };

    case 'signed-out':
      return { status: 'error', message: 'Your session has expired. Sign in again.' };

    case 'unreachable':
    case 'malformed':
      // Worth being explicit that nothing changed: somebody who has just tried
      // to stop the platform doing something needs to know whether they
      // succeeded, and "that did not complete" is ambiguous on its own.
      return {
        status: 'error',
        message: `That did not complete and nothing was changed — ${outcome.reason}`,
      };
  }
}

export async function setFeatureFlagAction(
  _previous: FeatureFlagActionState,
  form: FormData,
): Promise<FeatureFlagActionState> {
  const key = String(form.get('key') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  // The button carries the value, so the two submits on each row are "turn on"
  // and "turn off" rather than a checkbox whose meaning depends on what it was
  // when the page was rendered. A stale page then cannot invert the operation.
  const enabled = form.get('enabled') === 'true';

  if (reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      ...INITIAL_FEATURE_FLAG_STATE,
      key,
      reason,
      status: 'error',
      message: REASON_HINT,
    };
  }

  const { getToken } = await auth();
  const outcome = await setFeatureFlag(
    webEnv().API_BASE_URL,
    await getToken(),
    key,
    enabled,
    reason,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  const described = describe(
    outcome,
    enabled
      ? 'Switched on. It takes effect immediately.'
      : 'Switched off. It takes effect immediately.',
  );

  if (described.status === 'done') revalidatePath('/admin/feature-flags');

  return {
    ...INITIAL_FEATURE_FLAG_STATE,
    key,
    // Cleared on success so the next change needs its own reason, kept on
    // failure so nobody retypes. A reason carried over from a previous switch
    // would be a lie in the trail.
    reason: described.status === 'done' ? '' : reason,
    status: described.status,
    message: described.message,
  };
}
