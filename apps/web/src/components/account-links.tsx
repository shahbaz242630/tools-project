import Link from 'next/link';
import type { MeResponse } from '@platform/contracts';

/**
 * Everything a person can do with their own account, in one list.
 *
 * Extracted from the page because the rules below deserve pinning: until this
 * slice they lived as a conditional in the middle of a server component, where
 * no test could reach them.
 *
 * **Two links are dropped while an account is suspended.** Saving a profile is
 * a change and the API refuses it, so the form would render and then lose the
 * work at the last step; and a suspended account has no public profile, so that
 * link would 404 (ADR 0024). A link that fails reads as a fault in the site
 * rather than as a decision somebody made, and a person who thinks the site is
 * broken keeps retrying instead of responding to the suspension.
 *
 * **The data-protection routes stay**, because they still work. UK GDPR access
 * and erasure rights do not lapse on suspension, and a right nobody can find is
 * not meaningfully available.
 */
export function AccountLinks({ account }: { account: MeResponse }) {
  const suspended = account.suspendedAt !== null;

  return (
    <ul>
      {suspended ? null : (
        <li>
          <Link href="/account/profile">Edit your profile</Link>
        </li>
      )}

      {/* Named for the devices as much as the email, and the wording is the
          entire point of it. Clerk's screen has listed active devices since
          slice 1.7 mounted it here to change an email address — with a browser,
          an IP and a city it resolves client-side, which our own webhook cannot
          (ADR 0025). Nobody looking for "which devices are signed in to my
          account" would ever have opened a link called "Email and sign-in".

          Kept while suspended, unlike the two either side of it. Nothing on
          that page calls our API, so nothing refuses it — and it is the only
          route to the one control a person suspected of a compromised account
          needs most. Changing an email there cannot lift a suspension: the
          suspension hangs off our `users` row, not off the credential. */}
      <li>
        <Link href="/account/email">Email, password and devices</Link>
      </li>

      {suspended ? null : (
        <li>
          {/* What everybody else sees. Linked from here on purpose: a person
              being asked for a home address should be one click from the page
              that proves how little of it is published. */}
          <Link href={`/users/${account.id}`}>View your public profile</Link>
        </li>
      )}

      <li>
        <Link href="/account/activity">Account activity</Link>
      </li>
      <li>
        <Link href="/account/data">Download your data</Link>
      </li>
      <li>
        <Link href="/account/delete">Delete your account</Link>
      </li>
    </ul>
  );
}
