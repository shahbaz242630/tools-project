import Link from 'next/link';
import type { MeResponse } from '@platform/contracts';
import styles from './account-links.module.css';

/**
 * Everything a person can do with their own account, in one list.
 *
 * Extracted from the page because the rules below deserve pinning: until slice
 * 1.11 they lived as a conditional in the middle of a server component, where no
 * test could reach them.
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
 * accident. **The design of 13 August draws it as a red row inside the card**;
 * slice D4 kept the separation and applied the danger treatment to it, because
 * colour alone would carry the meaning in a single channel (WCAG 1.4.1).
 *
 * **The sub-lines are new in D4** and the titles are not. Two of them differ
 * from the design deliberately: *"Email, password and devices"* stays as it is,
 * because the name is what lets somebody hunting for *which devices are signed
 * in to my account* find the page at all; and *"View your public profile"* stays
 * in the list, which the design drops — a person being asked for a home address
 * should be one click from the page that proves how little of it is published.
 */
export function AccountLinks({ account }: { account: MeResponse }) {
  const suspended = account.suspendedAt !== null;

  return (
    <>
      <ul className={styles.card}>
        {suspended ? null : (
          <Row
            href="/account/profile"
            title="Your profile"
            sub="Display name, address, how you list"
          />
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
        <Row
          href="/account/email"
          title="Email, password and devices"
          sub="Managed with your sign-in provider"
        />

        {suspended ? null : (
          <Row
            href={`/users/${account.id}`}
            title="View your public profile"
            sub="Exactly what a neighbour sees"
          />
        )}

        {/*
          **Kept while suspended, unlike the two above it, and the asymmetry is
          ADR 0024 rather than an oversight.** A suspended account may read what
          we hold about it and may not write anything others would see — and the
          API agrees: `GET /listings` allows a suspended caller, as does pausing,
          which is the one write that makes strangers see *less*. Dropping this
          link would leave a suspended owner unable to find the listings they are
          still permitted to take down.

          Added in slice 2.9a. Until then this list was the only route to
          anything a person owned, and it did not mention the listings — so an
          owner's way back to their own item was the UUID in their history.
        */}
        <Row
          href="/listings"
          title="Your listings"
          sub="Everything you have offered to lend"
        />

        <Row
          href="/account/activity"
          title="Account activity"
          sub="Recent sign-ins and account events"
        />
        <Row
          href="/account/data"
          title="Download your data"
          sub="A copy of everything we hold"
        />
      </ul>

      <DangerZone />
    </>
  );
}

function Row({
  href,
  title,
  sub,
}: {
  readonly href: string;
  readonly title: string;
  readonly sub: string;
}) {
  return (
    <li>
      <Link href={href} className={styles.row}>
        <span>
          <span className={styles.title}>{title}</span>
          <span className={styles.sub}>{sub}</span>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          &rsaquo;
        </span>
      </Link>
    </li>
  );
}

/**
 * The one action on this page that cannot be undone.
 *
 * **Set apart semantically, not only visually.** A `section` with its own
 * heading means somebody navigating by headings meets the warning before the
 * link, and somebody skimming does not find deletion sitting in a list of
 * everyday tasks. That was true when there was no stylesheet to lean on and it
 * is still the more durable half now that there is one.
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
    <section className={styles.danger} aria-labelledby="danger-zone">
      <h2 id="danger-zone" className={styles.dangerHeading}>
        Delete your account
      </h2>
      <p className={styles.dangerBody}>
        <strong>Deleting your account is immediate and cannot be undone.</strong> Your
        profile, your address and{' '}
        {/* Named explicitly since 2.8b, because it stopped being true that a
            listing survived — and "your account" is not a phrase most people
            read as including the six items they spent an evening listing. */}
        <strong>every listing you have</strong> are removed outright.
      </p>
      <Link href="/account/delete" className={styles.dangerLink}>
        Delete your account
      </Link>
    </section>
  );
}
