import { Time } from '@platform/core';
import {
  describeAction,
  describeActivityOrigin,
  describeActor,
} from '../lib/activity-display';
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
export function ActivityList({
  outcome,
  devices = new Map<string, string>(),
}: {
  outcome: ActivityOutcome;
  /**
   * Device descriptions by session, from the sign-in history beside this table.
   *
   * Defaulted to empty so the administrative view — which has no access to
   * somebody else's sign-ins, deliberately (ADR 0022, ADR 0025) — renders
   * addresses alone without needing to know this parameter exists.
   */
  devices?: ReadonlyMap<string, string>;
}) {
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
                <th scope="col">Who</th>
                <th scope="col">When</th>
                <th scope="col">From</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {outcome.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{describeAction(entry.action)}</td>
                  <td>
                    {/* The column this page existed without. An administrator
                        reading your account is recorded against them, so until
                        the trail was read from the target side too it appeared
                        nowhere you could see it (BRD §8.13, ADR 0021). */}
                    {describeActor(entry.by)}
                  </td>
                  <td>
                    {/* The machine-readable value stays in the markup so the
                        rendered text can be friendly without losing precision. */}
                    <time dateTime={entry.createdAt}>
                      {formatWhen(entry.createdAt)}
                    </time>
                  </td>
                  <td>
                    {/* The device comes from the sign-in this action shares a
                        session with — the whole point of recording the session
                        on the entry, and what turns "something happened at
                        03:15" into "something happened in that sign-in from a
                        device you did not recognise".

                        Genuinely unknown rather than missing when neither is
                        available: the API never sees a browser directly, so
                        there is no address unless a proxy forwarded one. Saying
                        "not recorded" is honest; a blank cell reads as a bug.

                        Always bare on somebody else's action — both the address
                        and the session are the administrator's, and the API
                        withholds them. */}
                    {describeActivityOrigin(entry, devices)}
                  </td>
                  <td>
                    {/* Present when somebody was accountable for the action —
                        an administrator reaching into this account has to say
                        why, and the person it happened to can read it (BRD
                        §8.13). Ordinary actions owe no explanation. */}
                    {entry.reason ?? '—'}
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

function formatWhen(iso: string): string {
  return Time.fromIsoUtc(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  });
}
