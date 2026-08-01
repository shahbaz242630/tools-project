import { Time } from '@platform/core';
import Link from 'next/link';
import type { MeResponse } from '@platform/contracts';

/**
 * What a suspended person is told.
 *
 * Three things, and the order is the point: **that** the account is suspended,
 * **why** in the administrator's own words, and **what still works**. Leaving
 * any of them out produces a page that reads as a fault rather than a decision,
 * and somebody who thinks the site is broken keeps retrying instead of
 * responding.
 *
 * The reason is shown verbatim. That is the same bargain ADR 0021 struck for
 * administrative reads: whoever writes it knows the person will read it, which
 * makes it something you would be willing to say to their face.
 *
 * Renders nothing at all for an account that is not suspended — a banner that
 * appears greyed-out or empty would worry people for no reason.
 */
export function SuspensionNotice({ account }: { account: MeResponse }) {
  if (account.suspendedAt === null) return null;

  return (
    <section aria-labelledby="suspended" role="alert">
      <h2 id="suspended">This account is suspended</h2>

      <p>
        An administrator suspended it on{' '}
        <time dateTime={account.suspendedAt}>{formatWhen(account.suspendedAt)}</time>.
        You cannot list, book or change your profile while it is suspended.
      </p>

      {account.suspensionReason === null ? null : (
        <>
          <p>The reason recorded was:</p>
          <blockquote>{account.suspensionReason}</blockquote>
        </>
      )}

      <p>
        {/* Data-protection rights do not lapse on suspension, and saying so
            here is what makes them reachable in practice rather than only in
            principle (ADR 0024). */}
        You can still{' '}
        <Link href="/account/data">download everything we hold about you</Link> and{' '}
        <Link href="/account/delete">delete your account</Link>. Your{' '}
        <Link href="/account/activity">account activity</Link> shows what was recorded
        and when.
      </p>
    </section>
  );
}

function formatWhen(iso: string): string {
  return Time.fromIsoUtc(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  });
}
