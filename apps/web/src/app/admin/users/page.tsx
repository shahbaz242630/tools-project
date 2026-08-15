import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { AdminUserLookup } from '../../../components/admin-user-lookup';
import { AdminNav } from '../../../components/admin-nav';
import { AdminAccessNotice, adminAccess } from '../admin-access';
import { clientIpFrom } from '../../../lib/client-ip';
import { webEnv } from '../../../lib/env';

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
 *
 * **It does now *ask*, though, which is a different thing.** This page had no
 * read at all, so it drew a lookup form — and the suspension controls behind it —
 * to callers the API was certain to refuse, the same defect slice 2.1 fixed on
 * `/admin/categories`. `adminAccess` puts the question first and renders the
 * answer; see `../admin-access.tsx` for why the flag list is what it asks.
 */
export default async function AdminUsersPage() {
  const { getToken } = await auth();
  const access = await adminAccess(
    webEnv().API_BASE_URL,
    await getToken(),
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

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

      {access.kind === 'permitted' ? (
        <AdminUserLookup />
      ) : (
        <AdminAccessNotice access={access} controls="the lookup" />
      )}

      <AdminNav current="/admin/users" />
    </main>
  );
}
