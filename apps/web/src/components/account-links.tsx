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
 *
 * **Deletion is not in this list** (slice 2.8b). It sits below in its own
 * region, because it is the one action here that cannot be undone and it was
 * previously the sixth bullet in a list of six, indistinguishable in weight from
 * "Download your data". Separating it is not decoration: a destructive control
 * that looks exactly like a navigational one is a control people press by
 * accident.
 */
export function AccountLinks({ account }: { account: MeResponse }) {
  const suspended = account.suspendedAt !== null;

  return (
    <>
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
      </ul>

      <DangerZone />
    </>
  );
}

/**
 * The one action on this page that cannot be undone.
 *
 * **Set apart semantically, not only visually.** A `section` with its own
 * heading means somebody navigating by headings meets the warning before the
 * link, and somebody skimming does not find deletion sitting in a list of
 * everyday tasks. There is no stylesheet to lean on here, so the separation has
 * to come from structure — which is the more durable half anyway.
 *
 * **Kept while suspended**, like the other data-protection routes: erasure
 * rights do not lapse on suspension (ADR 0024).
 *
 * The sentence names the two things people actually want to know before
 * following the link — that it is immediate, and what goes with the account.
 * The full breakdown §10.1 requires is on the page itself; this is enough to
 * stop somebody clicking to find out.
 */
function DangerZone() {
  return (
    <section aria-labelledby="danger-zone">
      <hr />
      <h2 id="danger-zone">Danger zone</h2>
      <p>
        <strong>Deleting your account is immediate and cannot be undone.</strong> Your
        profile, your address and{' '}
        {/* Named explicitly since 2.8b, because it stopped being true that a
            listing survived — and "your account" is not a phrase most people
            read as including the six items they spent an evening listing. */}
        <strong>every listing you have</strong> are removed outright.
      </p>
      <p>
        <Link href="/account/delete">Delete your account</Link>
      </p>
    </section>
  );
}
