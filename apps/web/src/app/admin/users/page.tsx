import Link from 'next/link';
import { AdminUserLookup } from '../../../components/admin-user-lookup';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Account lookup',
  robots: { index: false, follow: false },
};

/**
 * BRD §8.13's read-only "view as user".
 *
 * **A projection, not a session.** Nothing here signs you in as anybody: the
 * page asks the API what an administrator may see of an account and renders the
 * answer. Write-capable impersonation is prohibited at launch and no mechanism
 * for it exists (ADR 0022).
 *
 * **The page does not check whether you are an administrator, and that is not
 * an oversight.** The API does, on every request, along with the second factor.
 * A check here would be a second place for the rule to live and the easier of
 * the two to get wrong.
 */
export default function AdminUsersPage() {
  return (
    <main>
      <h1>Account lookup</h1>

      <p>
        Look up an account for support. This is recorded against that account with the
        reason you give, and <strong>they can read it</strong> on their own activity
        page — including your reason, but not your name or your address.
      </p>

      <p>
        It shows account state and the postal district. It deliberately does{' '}
        <strong>not</strong> show street lines or the phone number — the account holder
        can download those themselves from their own account page.
      </p>

      <AdminUserLookup />

      <p>
        <Link href="/admin/activity">Look up an account&rsquo;s activity</Link> ·{' '}
        <Link href="/admin/approvals">Role changes</Link> ·{' '}
        <Link href="/admin/feature-flags">Feature flags</Link> ·{' '}
        <Link href="/admin/categories">Categories</Link> ·{' '}
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
