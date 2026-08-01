'use client';

import { useActionState } from 'react';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import {
  INITIAL_SUSPENSION_STATE,
  decideSuspensionAction,
} from '../app/admin/users/actions';

/**
 * Suspending an account, or lifting a suspension.
 *
 * **Exactly one button, chosen by the state the account is already in.** Both
 * would be a control the API refuses, and a button that answers 409 reads as a
 * fault in the site rather than a decision about the account.
 *
 * The reason field says who reads it, and that is the whole control here. This
 * is the one admin action that is *not* behind a second administrator
 * (ADR 0024), so the accountability is the reason, the audit entry, and the
 * person seeing both.
 */
export function SuspensionControls({
  userId,
  suspended,
}: {
  userId: string;
  suspended: boolean;
}) {
  const [state, action, pending] = useActionState(
    decideSuspensionAction,
    INITIAL_SUSPENSION_STATE,
  );

  const decision = suspended ? 'reinstate' : 'suspend';

  return (
    <form action={action}>
      <h3>{suspended ? 'Lift the suspension' : 'Suspend this account'}</h3>

      {state.status === 'error' && state.message !== null ? (
        <p role="alert">{state.message}</p>
      ) : null}
      {state.status === 'done' && state.message !== null ? (
        <p role="status">{state.message}</p>
      ) : null}

      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="decision" value={decision} />

      <p>
        <label htmlFor="suspension-reason">Why</label>
        <input
          id="suspension-reason"
          name="reason"
          type="text"
          required
          minLength={MIN_ADMIN_REASON_LENGTH}
          defaultValue={state.reason}
          aria-describedby="suspension-help"
        />
      </p>
      <p id="suspension-help">
        {suspended
          ? 'Recorded against the account, and the account holder can read it.'
          : 'The account holder sees this on their account page. Write something you would say to them.'}
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Working…' : suspended ? 'Reinstate' : 'Suspend'}
        </button>
      </p>

      {suspended ? null : (
        // Said before the button is pressed, not after. An administrator who
        // believes suspension cuts somebody off entirely will be surprised by
        // an export request from them, and act on the surprise.
        <p>
          They will still be able to sign in to read and download their data, and to
          delete the account. Data-protection rights do not lapse on suspension.
        </p>
      )}
    </form>
  );
}
