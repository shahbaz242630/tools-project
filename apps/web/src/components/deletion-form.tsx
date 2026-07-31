'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import {
  INITIAL_DELETION_FORM_STATE,
  deleteAccountAction,
} from '../app/account/delete/actions';

/**
 * The confirmation, and what to say afterwards.
 *
 * A client component only because it uses `useActionState` to show the result.
 * The deletion itself runs on the server — the API is not reachable from a
 * browser and `CLERK_SECRET_KEY` must never leave it.
 *
 * The confirmation is a **typed word**, not a checkbox. There is no undo and no
 * grace period, so an accidental submit is total; making somebody type DELETE
 * is proportionate to a cost that cannot be reversed.
 */
export function DeletionForm() {
  const [state, action, pending] = useActionState(
    deleteAccountAction,
    INITIAL_DELETION_FORM_STATE,
  );

  if (state.status === 'deleted') {
    return (
      <section aria-labelledby="done" role="status">
        <h2 id="done">Your account has been deleted</h2>
        <p>Your details have been erased. Thank you for using the platform.</p>

        {state.credentialRemains ? (
          // Honest rather than tidy. The account is erased and its sessions are
          // refused, so nothing is reachable — but somebody may still look
          // signed in, and finding that out unexplained would be alarming.
          <p>
            Your sign-in may take a little longer to disappear. Your account is already
            deleted and cannot be used to reach anything.
          </p>
        ) : null}

        <p>
          <Link href="/">Return to the home page</Link>
        </p>
      </section>
    );
  }

  return (
    <form action={action}>
      {state.status === 'error' && state.message !== null ? (
        <p role="alert">{state.message}</p>
      ) : null}

      <p>
        <label htmlFor="confirmation">
          Type <strong>DELETE</strong> to confirm
        </label>
        <input
          id="confirmation"
          name="confirmation"
          type="text"
          required
          autoComplete="off"
          aria-describedby="confirmation-help"
        />
      </p>
      <p id="confirmation-help">
        This is the last step. Nothing is deleted until you submit this form.
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Deleting…' : 'Delete my account permanently'}
        </button>
      </p>

      <p>
        <Link href="/account">Cancel and go back</Link>
      </p>
    </form>
  );
}
