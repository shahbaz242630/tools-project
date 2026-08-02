import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { AccountLinks } from '../../components/account-links';
import { AccountReport } from '../../components/account-report';
import { SuspensionNotice } from '../../components/suspension-notice';
import { fetchAccount } from '../../lib/account';
import { clientIpFrom } from '../../lib/client-ip';
import { webEnv } from '../../lib/env';

/**
 * Never prerendered.
 *
 * The answer depends on who is asking, so a build-time render would bake one
 * visitor's result — or more likely "signed out" — into a static file and serve
 * it to everyone.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Account' };

export default async function AccountPage() {
  // `getToken()` mints a short-lived session token for *this* request. The web
  // app is transport: it forwards the token and the API verifies the signature.
  // It never tells the API who the caller is, because a service that believes
  // what its caller claims about identity has no access control at all.
  const { getToken } = await auth();
  const token = await getToken();

  // Forwarded because `account.provisioned` fires on whichever authenticated
  // request happens to be first, and for a new sign-up that is usually this one.
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchAccount(webEnv().API_BASE_URL, token, undefined, clientIp);

  return (
    <main>
      <h1>Account</h1>
      <p>
        Read from the API on each request, against the session token this browser holds.
        The account below is the platform record — not the identity provider’s.
      </p>

      {/* Above the account details, because "why can I not do anything" is the
          question a suspended person arrives with. */}
      {outcome.kind === 'signed-in' ? (
        <SuspensionNotice account={outcome.account} />
      ) : null}

      <AccountReport outcome={outcome} />

      {/* Which links a suspended account keeps is a rule rather than a layout
          choice, so it lives in the component where a test can reach it. */}
      {outcome.kind === 'signed-in' ? <AccountLinks account={outcome.account} /> : null}

      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
