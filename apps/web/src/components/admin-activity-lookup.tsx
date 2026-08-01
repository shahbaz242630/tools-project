'use client';

import { useActionState } from 'react';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import { describeAction, describeActorForAdmin } from '../lib/activity-display';
import {
  INITIAL_ADMIN_LOOKUP_STATE,
  lookUpActivityAction,
} from '../app/admin/activity/actions';

/**
 * The lookup form and its results.
 *
 * The reason field is not optional and the label says why it is kept: an
 * administrator should know, at the moment they type it, that the person whose
 * account they are looking at will read it. That is what makes a mandatory
 * reason a real control rather than a box to clear.
 */
export function AdminActivityLookup() {
  const [state, action, pending] = useActionState(
    lookUpActivityAction,
    INITIAL_ADMIN_LOOKUP_STATE,
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
            {pending ? 'Looking up…' : 'Look up activity'}
          </button>
        </p>
      </form>

      {state.status === 'loaded' ? (
        <section aria-labelledby="results">
          <h2 id="results">Activity</h2>

          {state.entries.length === 0 ? (
            // Distinct from an error. An account with no recorded activity is a
            // real answer, and it is the answer for one that does not exist —
            // the API does not distinguish them, and neither should this.
            <p>No activity is recorded for that account.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">What happened</th>
                  <th scope="col">Who</th>
                  <th scope="col">When</th>
                  <th scope="col">From</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {state.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{describeAction(entry.action)}</td>
                    <td>
                      {/* "Account holder", never "You" — the reader here is not
                          the subject, and getting that backwards is how a
                          support worker misreads whose action they see. */}
                      {describeActorForAdmin(entry.by)}
                    </td>
                    <td>
                      <time dateTime={entry.createdAt}>{entry.createdAt}</time>
                    </td>
                    <td>{entry.ipAddress ?? 'Not recorded'}</td>
                    <td>{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </>
  );
}
