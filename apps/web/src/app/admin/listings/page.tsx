import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { ListingModerationForm } from '../../../components/listing-moderation-form';
import { AdminNav } from '../../../components/admin-nav';
import { AdminAccessNotice, adminAccess } from '../admin-access';
import { clientIpFrom } from '../../../lib/client-ip';
import { webEnv } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Listing moderation',
  robots: { index: false, follow: false },
};

/**
 * Where an administrator decides what the platform permits of a listing
 * (§8.3, §9, ADR 0041, slice 2.8c).
 *
 * **A lookup by id, not a queue**, and that is scope rather than omission: BRD
 * §14 puts manual moderation queues in Phase 9 and automated prohibited-content
 * signals in Phase 6. What Phase 2 owes is the state and a human who can set it.
 * `/admin/users` has the same shape for the same reason.
 *
 * **The page does not check whether you are an administrator**, the same as every
 * other admin page. The API does, on every request, with the second factor
 * (ADR 0021). A check here would be a second place for the rule to live and the
 * easier of the two to get wrong. It does *ask* before drawing the form, which
 * is a different thing — see `../admin-access.tsx`.
 *
 * **There is still no read of the listing being decided about**, and the copy
 * below says so. What changed is that there is now somewhere to look: `/hire/:id`
 * shipped in slice 2.10 and renders any listing its owner has published and the
 * platform permits. That covers the commonest decision — a live listing somebody
 * reported — and not the two that matter most, a draft and one already hidden.
 */
export default async function AdminListingsPage() {
  const { getToken } = await auth();
  const access = await adminAccess(
    webEnv().API_BASE_URL,
    await getToken(),
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  return (
    <main>
      <h1>Listing moderation</h1>

      <p>
        Decide what the platform permits of one listing. This is <strong>not</strong>{' '}
        the same as what its owner wants: an owner publishes or pauses their own
        listing, and nothing you do here changes that. A listing is visible to the
        public only when its owner has published it <em>and</em> the platform permits
        it, so hiding one leaves their intent intact and approving it later puts it back
        exactly as they had it.
      </p>

      <section aria-labelledby="what-you-can-see">
        <h2 id="what-you-can-see">Seeing the listing you are deciding about</h2>

        {/*
          **Rewritten. The old wording sent a moderator to the database.**

          It said there was no way for an administrator to open somebody else's
          listing and "no public listing page yet either", and told the reader to
          check the row directly if the decision needed it. `/hire/:id` shipped
          in slice 2.10. The sentence had simply not been revisited, and the cost
          of that is high: it points somebody at production data for a question a
          URL answers, and it is exactly the instruction a moderator would follow.

          What stays true is narrower, and it is the part worth keeping: the
          public page shows only what the public can see, so a draft, a paused
          listing and one this page has already hidden all answer 404 there.
        */}
        <p>
          A listing its owner has published, and the platform permits, is at{' '}
          <code>/hire/&lt;id&gt;</code> — the same id you type below. That is what a
          renter sees, which is usually the right thing to judge.{' '}
          <Link href="/browse">Browse</Link> reaches the same pages by searching.
        </p>

        <p role="note">
          <strong>
            Three listings will not open there, and two of them are the decisions that
            matter.
          </strong>{' '}
          A draft, a listing its owner has paused, and one you have already hidden all
          answer &ldquo;not found&rdquo; on the public page — deliberately, because it
          discloses nothing about listings the public may not see. There is still{' '}
          <strong>no administrative view</strong> of a listing, so for those you are
          working from whatever the report gave you. Do not treat this form as evidence
          that you have looked.
        </p>

        <p>
          There is also <strong>no queue and no list</strong>. That is deliberate:
          manual review queues and automated content signals are later phases. If you
          have not been given an id, there is nothing to do here.
        </p>

        <p role="note">
          <strong>The owner reads what you write, on their own listing page</strong>{' '}
          (slice 2.8c-ii). They see that the platform is holding the listing back, and
          your reason <strong>exactly as you typed it</strong> — not a summary, and not
          your name. Write it accordingly. They are <strong>not</strong> emailed about
          it: notifications arrive in a later phase, so until then somebody only finds
          out by opening the page.
        </p>
      </section>

      <section aria-labelledby="what-is-recorded">
        <h2 id="what-is-recorded">What gets recorded</h2>

        <p>
          Every decision here is an administrative action (§8.13), so it is written to
          the audit trail with your account, the listing, the state before and after,
          and your reason. That is the difference between this and an owner pausing
          their own listing, which is theirs to do and is not recorded against anybody.
        </p>
      </section>

      {/*
        Only offered to somebody who could actually use it — the same rule slice
        2.1 learned on `/admin/categories`. This page had no read at all, so
        until now there was nothing on it that could refuse before the button
        did, and a moderation decision that bounces is one somebody repeats.
      */}
      {access.kind === 'permitted' ? (
        <ListingModerationForm />
      ) : (
        <AdminAccessNotice access={access} controls="this form" />
      )}

      <AdminNav current="/admin/listings" />
    </main>
  );
}
