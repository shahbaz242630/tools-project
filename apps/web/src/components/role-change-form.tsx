'use client';

import { useActionState } from 'react';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import {
  INITIAL_APPROVAL_STATE,
  proposeRoleChangeAction,
} from '../app/admin/approvals/actions';

/**
 * Propose a role change.
 *
 * The submit button says **Propose**, not Save or Apply, and that is not
 * wording for its own sake: an administrator who believes they have just
 * changed somebody's role will not go looking for the second approver, and the
 * change will sit in a queue nobody clears.
 */
export function RoleChangeForm() {
  const [state, action, pending] = useActionState(
    proposeRoleChangeAction,
    INITIAL_APPROVAL_STATE,
  );

  return (
    <form action={action}>
      {state.status === 'error' && state.message !== null ? (
        <p role="alert">{state.message}</p>
      ) : null}
      {state.status === 'done' && state.message !== null ? (
        <p role="status">{state.message}</p>
      ) : null}

      <p>
        <label htmlFor="userId">Account id</label>
        <input
          id="userId"
          name="userId"
          type="text"
          required
          defaultValue={state.userId}
        />
      </p>

      <p>
        <label htmlFor="role">New role</label>
        <select id="role" name="role" defaultValue="ADMIN">
          <option value="ADMIN">Administrator</option>
          <option value="USER">Ordinary user</option>
        </select>
      </p>

      <p>
        <label htmlFor="propose-reason">Why</label>
        <input
          id="propose-reason"
          name="reason"
          type="text"
          required
          minLength={MIN_ADMIN_REASON_LENGTH}
          defaultValue={state.reason}
          aria-describedby="propose-help"
        />
      </p>
      <p id="propose-help">
        Another administrator reads this before agreeing, and the account holder can
        read it afterwards.
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Proposing…' : 'Propose'}
        </button>
      </p>
    </form>
  );
}
