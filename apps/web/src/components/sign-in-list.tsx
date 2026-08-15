import { Time } from '@platform/core';
import Link from 'next/link';
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
                <th scope="col">Device</th>
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
                    {/* Either part may be absent — a delivery can carry no
                        request attributes and a user agent can fail to parse —
                        so the helper says "not recorded" rather than rendering
                        an empty cell that reads like a loading state.

                        There is no city here and there cannot be: a webhook
                        carries an IP and a user agent, and Clerk resolves a
                        place only on its Backend API, behind the secret key
                        ADR 0015 withholds from us (ADR 0025). */}
                    {describeSignInOrigin(entry)}
                  </td>
                  <td>
                    {/* The reader's own address, unlike the activity table
                        where it belongs to an administrator and is withheld.
                        Either IP family, which is why nothing here truncates —
                        and with no city to show, this is the field that answers
                        "was that me". */}
                    {entry.ipAddress ?? 'Not recorded'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {/* This sentence used to name an action and offer no way to take
                it — the reader was told to go somewhere and not taken there.
                A security page that shows a problem and no route out of it is
                one somebody reads and then does nothing about, which is the
                failure this whole table exists to prevent.

                Deep-linked to Clerk's `security` sub-path rather than to
                `/account/email` itself, because that lands on the *Profile*
                tab — a list of email addresses. Somebody who followed a link
                promising devices and arrived at an email form has been told to
                go somewhere and taken somewhere else, which is the same defect
                one step along.

                That sub-path is Clerk's routing, not ours, so it is a vendor
                path we depend on. Checked rather than assumed: an unrecognised
                sub-path renders the component shell with an empty panel and a
                working sidebar — degraded and recoverable, not a 404 and not a
                blank page. Acceptable for the benefit; if it ever regresses,
                drop the suffix and the link still reaches the right screen. */}
            Do not recognise one of these?{' '}
            <Link href="/account/email/security">
              Review the devices signed in to your account
            </Link>{' '}
            and change your password.
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

    case 'forbidden':
      return (
        <section aria-labelledby="sign-ins">
          <h2 id="sign-ins">Sign-in history unavailable</h2>
          {/* The same two claims as the branch below refuses to make, plus one
              this branch refuses on its own: it must not offer the sign-in
              prompt. The token was accepted — being refused is not being signed
              out, and conflating them sends somebody round a loop. */}
          <p>
            Your sign-in history was not shown to you, so this is not a record of nobody
            signing in. That is a decision about your account rather than a fault.
          </p>
          <p>
            If your account has been suspended, the reason is on your{' '}
            <Link href="/account">account page</Link>.
          </p>
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
