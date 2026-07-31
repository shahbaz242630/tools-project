import { Time } from '@platform/core';
import type { ActivityOutcome } from '../lib/activity';

/**
 * The signed-in person's own account activity.
 *
 * Presentational and exhaustive, so adding a case to `ActivityOutcome` is a
 * type error here rather than a blank panel.
 *
 * The distinction it exists to preserve is between **an empty log and a log
 * that could not be read**. "Nothing has happened on your account" is a
 * security claim; rendering it because the API timed out would be a false
 * reassurance, which is worse than an error message.
 */
export function ActivityList({ outcome }: { outcome: ActivityOutcome }) {
  switch (outcome.kind) {
    case 'loaded':
      if (outcome.entries.length === 0) {
        return (
          <section aria-labelledby="activity">
            <h2 id="activity">Account activity</h2>
            <p>Nothing has been recorded on your account yet.</p>
          </section>
        );
      }

      return (
        <section aria-labelledby="activity">
          <h2 id="activity">Account activity</h2>
          <table>
            <caption>Most recent first.</caption>
            <thead>
              <tr>
                <th scope="col">What happened</th>
                <th scope="col">When</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {outcome.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{describeAction(entry.action)}</td>
                  <td>
                    {/* The machine-readable value stays in the markup so the
                        rendered text can be friendly without losing precision. */}
                    <time dateTime={entry.createdAt}>
                      {formatWhen(entry.createdAt)}
                    </time>
                  </td>
                  <td>
                    {/* Genuinely unknown rather than missing: the API never sees
                        a browser directly, so there is no address to record
                        unless a proxy forwarded one. Saying "not recorded" is
                        honest; a blank cell reads as a bug. */}
                    {entry.ipAddress ?? 'Not recorded'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );

    case 'signed-out':
      return (
        <section aria-labelledby="activity">
          <h2 id="activity">Account activity</h2>
          <p>Sign in to see activity on your account.</p>
        </section>
      );

    case 'unreachable':
    case 'malformed':
      return (
        <section aria-labelledby="activity">
          <h2 id="activity">Activity unavailable</h2>
          {/* Deliberately not "nothing has happened". We do not know that. */}
          <p>
            Your account activity could not be loaded, so this is not a record of
            nothing happening — {outcome.reason}
          </p>
        </section>
      );
  }
}

/**
 * `profile.updated` → "Profile updated".
 *
 * A lookup rather than a string transform, because the vocabulary is closed and
 * a machine-readable action is not a sentence. An unrecognised action falls
 * back to the raw value: a new action added to the API before this map is a
 * slightly ugly row, not a missing one, and a missing row in an audit trail is
 * the failure that matters.
 */
const DESCRIPTIONS: Record<string, string> = {
  'account.provisioned': 'Account created',
  'profile.created': 'Profile created',
  'profile.updated': 'Profile updated',
};

function describeAction(action: string): string {
  return DESCRIPTIONS[action] ?? action;
}

function formatWhen(iso: string): string {
  return Time.fromIsoUtc(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  });
}
