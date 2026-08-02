import { Time } from '@platform/core';
import { describeSignInOrigin } from '@platform/contracts';
import type { SignInEntry } from '@platform/contracts';
import type { SignInsOutcome } from '../lib/sign-ins';

/**
 * The signed-in person's own sign-in history — BRD §8.1's authentication events.
 *
 * Presentational and exhaustive, so adding a case to `SignInsOutcome` is a type
 * error here rather than a blank panel.
 *
 * **The empty state is the one that had to be worded carefully.** For the
 * activity trail, "nothing has happened yet" is merely unhelpful; here it would
 * read as "nobody has signed in", which is never true of somebody looking at
 * the page. The real meaning is that we started recording recently, and the
 * copy says exactly that.
 */
export function SignInList({ outcome }: { outcome: SignInsOutcome }) {
  switch (outcome.kind) {
    case 'loaded':
      if (outcome.entries.length === 0) {
        return (
          <section aria-labelledby="sign-ins">
            <h2 id="sign-ins">Sign-in history</h2>
            {/* Not "nobody has signed in" — the reader plainly has. An empty
                list means we have no record yet, which is a different claim
                and the only honest one to make. */}
            <p>
              No sign-ins recorded yet. We only hold sign-ins from the point this record
              began, so an empty list is not evidence that nobody signed in before then.
            </p>
          </section>
        );
      }

      return (
        <section aria-labelledby="sign-ins">
          <h2 id="sign-ins">Sign-in history</h2>
          <table>
            <caption>Most recent first.</caption>
            <thead>
              <tr>
                <th scope="col">What happened</th>
                <th scope="col">When</th>
                <th scope="col">Device and place</th>
                <th scope="col">IP address</th>
              </tr>
            </thead>
            <tbody>
              {outcome.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{describeEvent(entry)}</td>
                  <td>
                    <time dateTime={entry.occurredAt}>
                      {formatWhen(entry.occurredAt)}
                    </time>
                  </td>
                  <td>
                    {/* Any part of this may be absent — Clerk's activity object
                        is optional and so is every field in it — so the helper
                        says "not recorded" rather than rendering an empty cell
                        that reads like a loading state. */}
                    {describeSignInOrigin(entry)}
                  </td>
                  <td>
                    {/* The reader's own address, unlike the activity table
                        where it belongs to an administrator and is withheld.
                        Frequently IPv6, which is why nothing here truncates. */}
                    {entry.ipAddress ?? 'Not recorded'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Do not recognise one of these? Change your password at your account provider
            and sign out of every other device.
          </p>
        </section>
      );

    case 'signed-out':
      return (
        <section aria-labelledby="sign-ins">
          <h2 id="sign-ins">Sign-in history</h2>
          <p>Sign in to see the sign-in history for your account.</p>
        </section>
      );

    case 'unreachable':
    case 'malformed':
      return (
        <section aria-labelledby="sign-ins">
          <h2 id="sign-ins">Sign-in history unavailable</h2>
          {/* Deliberately not the empty state. We do not know that nobody
              signed in; we know we could not find out. */}
          <p>
            Your sign-in history could not be loaded, so this is not a record of nobody
            signing in — {outcome.reason}
          </p>
        </section>
      );
  }
}

/**
 * What happened, in words.
 *
 * The four are kept distinct rather than collapsed to "signed in" and "signed
 * out", because `revoked` is the one a person scanning for an intrusion is
 * looking for — a session somebody deliberately killed, possibly not them.
 */
function describeEvent(entry: SignInEntry): string {
  switch (entry.event) {
    case 'started':
      return 'Signed in';
    case 'ended':
      return 'Signed out';
    case 'removed':
      return 'Session removed';
    case 'revoked':
      return 'Session revoked';
  }
}

function formatWhen(iso: string): string {
  return Time.fromIsoUtc(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  });
}
