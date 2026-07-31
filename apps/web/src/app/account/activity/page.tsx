import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { ActivityList } from '../../../components/activity-list';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchActivity } from '../../../lib/activity';
import { webEnv } from '../../../lib/env';

/** Never prerendered — the answer depends entirely on who is asking. */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Account activity' };

export default async function ActivityPage() {
  const { getToken } = await auth();

  // Read here rather than inside the client: `headers()` is only available in a
  // request scope, and this is the boundary where one exists.
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchActivity(
    webEnv().API_BASE_URL,
    await getToken(),
    undefined,
    clientIp,
  );

  return (
    <main>
      <h1>Account activity</h1>
      <p>
        Security-relevant actions on your account. This record is append-only — we
        cannot edit or remove an entry, and neither can anyone else.
      </p>

      <ActivityList outcome={outcome} />

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
