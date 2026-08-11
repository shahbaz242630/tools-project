import Link from 'next/link';
import { ListingModerationForm } from '../../../components/listing-moderation-form';

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
 * easier of the two to get wrong.
 *
 * **Nothing is read before the decision is written**, which makes this the first
 * admin page with no read at all — and it is a real limitation rather than a
 * simplification. Every read in Catalogue is owner-scoped, so there is no route
 * by which an administrator can fetch somebody else's listing; the public listing
 * page arrives in 2.10 and the queue that would show it in Phase 9. The copy
 * below says so, because a moderator who assumes they are looking at what they
 * are deciding about is the one thing this page must not encourage.
 */
export default function AdminListingsPage() {
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

      <section aria-labelledby="what-you-cannot-see">
        <h2 id="what-you-cannot-see">What this page cannot show you</h2>

        <p role="note">
          <strong>You are deciding without seeing the listing.</strong> Every way of
          reading a listing today is scoped to its owner, so there is no way for an
          administrator to open somebody else&rsquo;s — there is no public listing page
          yet either. Until there is, work from whatever the report gave you and check
          the listing directly in the database if the decision needs it. Do not treat
          this form as evidence that you have looked.
        </p>

        <p>
          There is also <strong>no queue and no list</strong>. That is deliberate:
          manual review queues and automated content signals are later phases. If you
          have not been given an id, there is nothing to do here.
        </p>

        <p role="note">
          <strong>The owner is not told yet.</strong> The reason you give is stored and
          recorded against you, but nothing shows it to them — so a listing you hide now
          disappears from public view with no explanation reaching its owner. That is
          the next slice. Bear it in mind before hiding anything belonging to somebody
          real.
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

      <ListingModerationForm />

      <nav>
        <Link href="/admin/users">Look up an account</Link>
        {' · '}
        <Link href="/admin/activity">Look up an account&rsquo;s activity</Link>
        {' · '}
        <Link href="/admin/categories">Categories</Link>
        {' · '}
        <Link href="/admin/feature-flags">Feature flags</Link>
        {' · '}
        <Link href="/admin/approvals">Role changes</Link>
        {' · '}
        <Link href="/account">Back to your account</Link>
      </nav>
    </main>
  );
}
