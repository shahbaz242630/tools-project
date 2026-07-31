import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { AccountReport } from '../../components/account-report';
import { fetchAccount } from '../../lib/account';
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

  const outcome = await fetchAccount(webEnv().API_BASE_URL, token);

  return (
    <main>
      <h1>Account</h1>
      <p>
        Read from the API on each request, against the session token this browser holds.
        The account below is the platform record — not the identity provider’s.
      </p>

      <AccountReport outcome={outcome} />

      {outcome.kind === 'signed-in' ? (
        <ul>
          <li>
            <Link href="/account/profile">Edit your profile</Link>
          </li>
          <li>
            {/* What everybody else sees. Linked from here on purpose: a person
                being asked for a home address should be one click from the page
                that proves how little of it is published. */}
            <Link href={`/users/${outcome.account.id}`}>View your public profile</Link>
          </li>
        </ul>
      ) : null}

      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
