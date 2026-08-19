import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { OwnerBookingList, RenterBookings } from '../../components/booking-list';
import { clientIpFrom } from '../../lib/client-ip';
import { fetchBookingsOnMyListings, fetchMyBookings } from '../../lib/bookings';
import { webEnv } from '../../lib/env';
import styles from './bookings.module.css';

/** Never prerendered — the answer is entirely about who is asking. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your bookings',
  /**
   * **`noindex`, like the owner's listings page and for the same reason.** This
   * is somebody's own record of what they have hired and what has been hired
   * from them. The crawlable pages are the public listing and `/browse`.
   */
  robots: { index: false, follow: false },
};

/**
 * Everything you are part of, both ways round (§14's *dashboards for both
 * parties*, slice 4.8b).
 *
 * **One page with two sections rather than two pages.** A person thinks *show me
 * my bookings*, not *show me my two roles* — and at this platform's scale the
 * same account is routinely both parties. Two nav entries would ask somebody to
 * classify themselves before they can look.
 *
 * **Both reads run together.** They are independent routes and neither depends on
 * the other's answer, so awaiting them in sequence would double the wait for no
 * reason. `Promise.all` is safe here because each `fetch*` resolves to an outcome
 * rather than throwing — a failure on one side renders its own sentence and
 * leaves the other side intact, which is the behaviour a person wants: an owner
 * whose renter list times out should still see what is booked on their items.
 *
 * A composition root: it reads, and the two components decide what any of it
 * means. That split is this project's coverage rule — App Router pages are
 * excluded from the thresholds and not unit tested, so anything with a decision
 * in it belongs in a component where a test can hold it.
 */
export default async function BookingsPage() {
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));
  const apiBaseUrl = webEnv().API_BASE_URL;

  const [hiring, letting] = await Promise.all([
    fetchMyBookings(apiBaseUrl, token, undefined, clientIp),
    fetchBookingsOnMyListings(apiBaseUrl, token, undefined, clientIp),
  ]);

  return (
    <main className={styles.page}>
      <h1>Your bookings</h1>
      <p>
        What you have asked to hire, and what other people have asked to hire from you.
        Only you can see this page.
      </p>

      <section className={styles.section} aria-labelledby="hiring">
        <h2 id="hiring" className={styles.heading}>
          Items you are hiring
        </h2>
        <p className={styles.blurb}>Requests you have made, and what became of them.</p>

        <RenterBookings outcome={hiring} />
      </section>

      <section className={styles.section} aria-labelledby="letting">
        <h2 id="letting" className={styles.heading}>
          Bookings on your items
        </h2>
        {/*
          **The pointer to where answering happens is not here, and that is a
          correction rather than a preference.** This blurb read *"Open an item to
          answer a request that is still waiting"* until the page was looked at —
          shown to an owner whose four bookings were all already answered, which
          is an instruction aimed at nothing. It now lives in the list, which is
          the only thing that knows whether anything is waiting.
        */}
        <p className={styles.blurb}>Everything people have asked to hire from you.</p>

        <OwnerBookingList outcome={letting} />
      </section>

      <p className={styles.footnote}>
        <Link href="/listings">Your listings</Link> ·{' '}
        <Link href="/browse">Find something to hire</Link> ·{' '}
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
