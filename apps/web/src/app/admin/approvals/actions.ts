'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import type { AdminApprovalView, UserRole } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { decideApproval, proposeRoleChange } from '../../../lib/admin-approvals';
import { webEnv } from '../../../lib/env';

/**
 * Proposing a role change, and deciding somebody else's proposal.
 *
 * Reasons are validated here *and* by the API, and the API's answer is the one
 * that counts — a check in a form is a convenience, never a control.
 */

export interface ApprovalActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  /** Kept so the form does not clear what was typed on a failure. */
  readonly userId: string;
  readonly reason: string;
}

export const INITIAL_APPROVAL_STATE: ApprovalActionState = {
  status: 'idle',
  message: null,
  userId: '',
  reason: '',
};

/** Turn an outcome into something an administrator can act on. */
function describe(
  outcome: Awaited<ReturnType<typeof decideApproval>>,
  done: (value: AdminApprovalView) => string,
): { status: 'done' | 'error'; message: string } {
  switch (outcome.kind) {
    case 'loaded':
      return { status: 'done', message: done(outcome.value) };

    case 'refused':
      // Not a malformed request. Retyping will not help, and saying "check your
      // input" would send somebody round a loop they cannot exit.
      return { status: 'error', message: outcome.reason };

    case 'invalid':
      return { status: 'error', message: outcome.issues.join('; ') };

    case 'not-found':
      return { status: 'error', message: 'That proposal no longer exists.' };

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
      return {
        status: 'error',
        message: `That did not complete — ${outcome.reason}`,
      };
  }
}

async function context() {
  const { getToken } = await auth();
  return {
    api: webEnv().API_BASE_URL,
    token: await getToken(),
    clientIp: clientIpFrom((await headers()).get('x-forwarded-for')),
  };
}

export async function proposeRoleChangeAction(
  _previous: ApprovalActionState,
  form: FormData,
): Promise<ApprovalActionState> {
  const userId = String(form.get('userId') ?? '').trim();
  const role = String(form.get('role') ?? '') as UserRole;
  const reason = String(form.get('reason') ?? '').trim();
  const typed = { userId, reason };

  if (userId === '') {
    return {
      ...INITIAL_APPROVAL_STATE,
      ...typed,
      status: 'error',
      message: 'Enter the account id whose role should change.',
    };
  }

  if (reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      ...INITIAL_APPROVAL_STATE,
      ...typed,
      status: 'error',
      message: `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. Another administrator has to read it before agreeing.`,
    };
  }

  const { api, token, clientIp } = await context();
  const outcome = await proposeRoleChange(
    api,
    token,
    { userId, role, reason },
    undefined,
    clientIp,
  );

  const result = describe(
    outcome,
    () =>
      'Proposed. Nothing has changed yet — another administrator has to agree, ' +
      'and it cannot be you.',
  );

  revalidatePath('/admin/approvals');
  return { ...INITIAL_APPROVAL_STATE, ...typed, ...result };
}

export async function decideApprovalAction(
  _previous: ApprovalActionState,
  form: FormData,
): Promise<ApprovalActionState> {
  const id = String(form.get('id') ?? '').trim();
  const decision = form.get('decision') === 'cancel' ? 'cancel' : 'approve';
  const reason = String(form.get('reason') ?? '').trim();

  if (reason.length < MIN_ADMIN_REASON_LENGTH) {
    return {
      ...INITIAL_APPROVAL_STATE,
      reason,
      status: 'error',
      message: `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. It is recorded against the account, and they can read it.`,
    };
  }

  const { api, token, clientIp } = await context();
  const outcome = await decideApproval(
    api,
    token,
    id,
    decision,
    reason,
    undefined,
    clientIp,
  );

  const result = describe(outcome, () =>
    decision === 'approve'
      ? 'Approved, and the change has taken effect.'
      : 'Withdrawn. Nothing changed.',
  );

  revalidatePath('/admin/approvals');
  return { ...INITIAL_APPROVAL_STATE, reason, ...result };
}
