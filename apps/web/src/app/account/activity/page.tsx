import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { ActivityList } from '../../../components/activity-list';
import { SignInList } from '../../../components/sign-in-list';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchActivity } from '../../../lib/activity';
import { fetchSignIns } from '../../../lib/sign-ins';
import { webEnv } from '../../../lib/env';

/** Never prerendered — the answer depends entirely on who is asking. */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Account activity' };

export default async function ActivityPage() {
  const { getToken } = await auth();

  // Read here rather than inside the client: `headers()` is only available in a
  // request scope, and this is the boundary where one exists.
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const token = await getToken();

  // Two calls, two modules. The activity trail belongs to Audit and the
  // sign-ins to Identity & Access, which already writes to Audit — having Audit
  // read back would close a cycle between them, so the merge happens here where
  // the page is assembled rather than in either module (ADR 0025).
  //
  // Concurrent, because they are independent: serialising them would make the
  // page as slow as the sum of two timeouts for no reason. One failing does not
  // take the other down — each renders its own outcome.
  const [outcome, signIns] = await Promise.all([
    fetchActivity(webEnv().API_BASE_URL, token, undefined, clientIp),
    fetchSignIns(webEnv().API_BASE_URL, token, undefined, clientIp),
  ]);

  return (
    <main>
      <h1>Account activity</h1>
      <p>
        Security-relevant actions on your account. This record is append-only — we
        cannot edit or remove an entry, and neither can anyone else.
      </p>

      <ActivityList outcome={outcome} />

      <SignInList outcome={signIns} />

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
