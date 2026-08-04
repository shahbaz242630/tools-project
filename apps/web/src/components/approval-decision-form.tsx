'use client';

import { useActionState } from 'react';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import { decideApprovalAction } from '../app/admin/approvals/actions';
import { INITIAL_APPROVAL_STATE } from '../app/admin/approvals/state';

/**
 * Agree to, or withdraw, one proposal.
 *
 * Two submit buttons on one form rather than two forms, so the reason field is
 * shared: whichever decision is taken, it is taken *with* an explanation, and a
 * layout where one button had a reason box and the other did not would make the
 * second one the easy path.
 */
export function ApprovalDecisionForm({
  id,
  canApprove,
}: {
  id: string;
  /** False when the viewer proposed this. A courtesy, not the control. */
  canApprove: boolean;
}) {
  const [state, action, pending] = useActionState(
    decideApprovalAction,
    INITIAL_APPROVAL_STATE,
  );

  const reasonId = `reason-${id}`;

  return (
    <form action={action}>
      {state.status === 'error' && state.message !== null ? (
        <p role="alert">{state.message}</p>
      ) : null}
      {state.status === 'done' && state.message !== null ? (
        <p role="status">{state.message}</p>
      ) : null}

      <input type="hidden" name="id" value={id} />

      <p>
        <label htmlFor={reasonId}>Your reason</label>
        <input
          id={reasonId}
          name="reason"
          type="text"
          required
          minLength={MIN_ADMIN_REASON_LENGTH}
          defaultValue={state.reason}
        />
      </p>

      <p>
        {canApprove ? (
          <button type="submit" name="decision" value="approve" disabled={pending}>
            {pending ? 'Working…' : 'Approve and apply'}
          </button>
        ) : null}{' '}
        <button type="submit" name="decision" value="cancel" disabled={pending}>
          {pending ? 'Working…' : 'Withdraw'}
        </button>
      </p>
    </form>
  );
}
