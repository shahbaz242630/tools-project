import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { AccountHeader } from '../../components/account-header';
import { AccountLinks } from '../../components/account-links';
import { AccountReport } from '../../components/account-report';
import { SuspensionNotice } from '../../components/suspension-notice';
import { fetchAccount } from '../../lib/account';
import { clientIpFrom } from '../../lib/client-ip';
import { webEnv } from '../../lib/env';
import { fetchMyProfile } from '../../lib/profile';

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

  /*
   * **A second call, and only this page pays for it** (slice D4). The header
   * wants a display name, a town and a postcode district, none of which `/me`
   * carries — it answers with identity, not with the profile. Reading it in the
   * root layout instead would charge every page in the application, including
   * the public listing page that has to stay fast, so the cost is taken where
   * the benefit is.
   *
   * Its failure is not this page's failure. A profile that will not load leaves
   * the header on the email alone; the account details below, and the links a
   * suspended person needs, do not depend on it.
   */
  const profile = await fetchMyProfile(
    webEnv().API_BASE_URL,
    token,
    undefined,
    clientIp,
  );

  return (
    <main>
      {outcome.kind === 'signed-in' ? (
        <AccountHeader
          account={outcome.account}
          profile={profile.kind === 'loaded' ? profile.profile : null}
        />
      ) : (
        <h1>Account</h1>
      )}

      {/* Above the account details, because "why can I not do anything" is the
          question a suspended person arrives with. */}
      {outcome.kind === 'signed-in' ? (
        <SuspensionNotice account={outcome.account} />
      ) : null}

      {/* Which links a suspended account keeps is a rule rather than a layout
          choice, so it lives in the component where a test can reach it. */}
      {outcome.kind === 'signed-in' ? <AccountLinks account={outcome.account} /> : null}

      {/*
        Moved below the links in D4, and demoted from the page's opening
        paragraph to its closing note. It answers "where did this come from",
        which is a question somebody asks second — the design puts the same
        sentence in the same place for the same reason. `AccountReport` still
        carries every not-signed-in and could-not-tell branch, so an unreachable
        API is still explained rather than rendered as an empty page.
      */}
      <AccountReport outcome={outcome} />

      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
