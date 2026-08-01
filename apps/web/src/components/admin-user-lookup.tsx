'use client';

import { useActionState } from 'react';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import type { AdminUserView } from '@platform/contracts';
import {
  INITIAL_ADMIN_USER_STATE,
  lookUpAccountAction,
} from '../app/admin/users/actions';

/**
 * The account lookup form and what it found.
 *
 * Read-only by construction: there is nothing on this screen that submits a
 * change, because the API offers none. BRD §8.13 permits read-only support
 * access from Phase 1 and prohibits write-capable impersonation at launch
 * (ADR 0022).
 */
export function AdminUserLookup() {
  const [state, action, pending] = useActionState(
    lookUpAccountAction,
    INITIAL_ADMIN_USER_STATE,
  );

  return (
    <>
      <form action={action}>
        {state.status === 'error' && state.message !== null ? (
          <p role="alert">{state.message}</p>
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
          <label htmlFor="reason">Why you are looking</label>
          <input
            id="reason"
            name="reason"
            type="text"
            required
            minLength={MIN_ADMIN_REASON_LENGTH}
            defaultValue={state.reason}
            aria-describedby="reason-help"
          />
        </p>
        <p id="reason-help">
          Recorded against the account you are viewing. The person it belongs to can
          read this.
        </p>

        <p>
          <button type="submit" disabled={pending}>
            {pending ? 'Looking up…' : 'Look up account'}
          </button>
        </p>
      </form>

      {state.status === 'loaded' && state.view !== null ? (
        <AccountView view={state.view} />
      ) : null}
    </>
  );
}

function AccountView({ view }: { view: AdminUserView }) {
  const { account, profile } = view;

  return (
    <section aria-labelledby="account">
      <h2 id="account">Account</h2>

      <dl>
        <dt>Account id</dt>
        <dd>{account.id}</dd>

        <dt>Email</dt>
        <dd>{account.email}</dd>

        <dt>Role</dt>
        <dd>{account.role}</dd>

        <dt>Created</dt>
        <dd>
          <time dateTime={account.createdAt}>{account.createdAt}</time>
        </dd>

        <dt>Deletion requested</dt>
        <dd>{account.deletionRequestedAt ?? 'No'}</dd>

        <dt>Deleted</dt>
        {/* Shown rather than hidden. Support is asked about deleted accounts
            precisely because they are deleted, and "when" is the answer. */}
        <dd>{account.deletedAt ?? 'No'}</dd>
      </dl>

      <h2>Profile</h2>

      {profile === null ? (
        // Not an error, and worth distinguishing from a broken lookup: plenty
        // of accounts exist without anyone having filled a profile in.
        <p>No profile has been created for this account.</p>
      ) : (
        <dl>
          <dt>Display name</dt>
          <dd>{profile.displayName}</dd>

          <dt>Phone number saved</dt>
          {/* Whether, not what. The digits answer nothing the boolean does not,
              and they are somebody's phone number (ADR 0022). */}
          <dd>{profile.hasPhone ? 'Yes' : 'No'}</dd>

          <dt>Area</dt>
          <dd>
            {profile.address === null
              ? 'No address saved'
              : `${profile.address.town} (${profile.address.outwardCode})`}
          </dd>

          <dt>Last updated</dt>
          <dd>
            <time dateTime={profile.updatedAt}>{profile.updatedAt}</time>
          </dd>
        </dl>
      )}

      <p>
        This view shows the postal district only, and does not show street lines or the
        phone number. If the account holder needs a full copy of what we hold, they can
        download one from their own account page.
      </p>
    </section>
  );
}
