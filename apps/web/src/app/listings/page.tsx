import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { ListingList } from '../../components/listing-list';
import { clientIpFrom } from '../../lib/client-ip';
import { fetchOwnedListings } from '../../lib/listings';
import { webEnv } from '../../lib/env';

/** Never prerendered — the answer is entirely about who is asking. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your listings',
  /**
   * **`noindex`, like the single-listing page and for the same reason.** This is
   * somebody's own management view, showing drafts, paused items and listings
   * the platform has refused. The crawlable page is 2.10's public one, which is
   * a different projection of different rows.
   */
  robots: { index: false, follow: false },
};

/**
 * Everything you have listed.
 *
 * A composition root: it reads, and `ListingList` decides what any of it means.
 * That split is this project's coverage rule — App Router pages are excluded
 * from the thresholds and not unit tested, so anything with a decision in it
 * belongs in a component where a test can hold it.
 */
export default async function ListingsPage() {
  const { getToken } = await auth();

  const outcome = await fetchOwnedListings(
    webEnv().API_BASE_URL,
    await getToken(),
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  return (
    <main>
      <h1>Your listings</h1>
      <p>
        Everything you have listed, whether it is live or not. Only you can see this
        page.
      </p>

      <ListingList outcome={outcome} />

      <p>
        <Link href="/listings/new">List another item</Link> ·{' '}
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
