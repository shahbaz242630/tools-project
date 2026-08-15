import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { AdminActivityLookup } from '../../../components/admin-activity-lookup';
import { AdminNav } from '../../../components/admin-nav';
import { AdminAccessNotice, adminAccess } from '../admin-access';
import { clientIpFrom } from '../../../lib/client-ip';
import { webEnv } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Account activity lookup',
  robots: { index: false, follow: false },
};

/**
 * The first administrative screen.
 *
 * Deliberately read-only. BRD §8.13 permits read-only support access from Phase
 * 1 and prohibits write-capable impersonation at launch, so there is nothing
 * here that changes anything.
 *
 * **The page does not check whether you are an administrator, and that is not
 * an oversight.** The API does, on every request, along with the second factor.
 * A check here would be a second place for the rule to live and the easier of
 * the two to get wrong — and hiding the form from an ordinary user protects
 * nothing, because the endpoint is what holds the data.
 *
 * **It does ask first, which is not the same as checking.** The lookup writes an
 * audit entry against somebody else's account before it discloses anything, so
 * offering it to a caller who will be refused is worse than a dead control — it
 * invites somebody to type a real account id and a real reason for nothing.
 */
export default async function AdminActivityPage() {
  const { getToken } = await auth();
  const access = await adminAccess(
    webEnv().API_BASE_URL,
    await getToken(),
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  return (
    <main>
      <h1>Account activity lookup</h1>

      <p>
        Read another account&rsquo;s activity for support. This is recorded against that
        account with the reason you give, and <strong>they can read it</strong> on their
        own activity page — including your reason, but not your name or your address.
      </p>

      <p>
        You will see the same history the account holder sees, so a colleague&rsquo;s
        earlier access to this account appears here too.
      </p>

      {access.kind === 'permitted' ? (
        <AdminActivityLookup />
      ) : (
        <AdminAccessNotice access={access} controls="the lookup" />
      )}

      <AdminNav current="/admin/activity" />
    </main>
  );
}
