import { notFound } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Money, Time } from '@platform/core';
import {
  BookingStateLabel,
  bookingStateWording,
} from '../../../components/booking-state';
import { BookingPayment } from '../../../components/booking-payment';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchBooking } from '../../../lib/bookings';
import { describeLine } from '../../../lib/line-items';
import { webEnv } from '../../../lib/env';
import { BOOKINGS_PAGE_PATH, hirePath } from '../../../lib/page-paths';
import { DamageHold } from '../../../components/damage-hold';
import styles from './booking.module.css';

/**
 * One booking, and where its renter pays for it (§8.6, §8.7, slice 5.2d).
 *
 * **This is the first caller `GET /bookings/:bookingId` has ever had.** The route
 * shipped in 4.5a and carried a deletion deadline in its docblock — *if Phase 5
 * closes without a caller, delete it* — because both dashboards read the
 * collection routes and nothing rendered a single booking. Paying is what needed
 * one: a list row is the wrong place to commit money from, and 3-D Secure needs
 * somewhere to happen.
 *
 * **`force-dynamic`**, like every page whose answer is entirely about who is
 * asking. It is also `noindex` — this is somebody's own record of a hire.
 *
 * **Both parties may open it, and only one sees a pay control.** `findForParty`
 * answers for the owner too (§8.6 gives them the decision), and what they see
 * instead is decided by the API's `payability`, not here. That is deliberate: a
 * page that worked out for itself whether to draw the button would be a second
 * implementation of a money rule living in a browser.
 *
 * A composition root: it reads and lays out, and the components decide what any
 * of it means. App Router pages are excluded from the coverage thresholds and not
 * unit tested, so anything with a decision in it belongs in a component where a
 * test can hold it — which is why the pay panel is one.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your booking',
  robots: { index: false, follow: false },
};

export default async function BookingPage({
  params,
}: {
  readonly params: Promise<{ readonly bookingId: string }>;
}) {
  const { bookingId } = await params;

  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchBooking(
    webEnv().API_BASE_URL,
    token,
    bookingId,
    undefined,
    clientIp,
  );

  /*
   * **One 404 for "no such booking" and for "not yours."** The API refuses to
   * tell them apart and this page must not undo that — a message saying the
   * booking exists but is somebody else's would confirm an id to whoever guessed
   * it.
   */
  if (outcome.kind === 'not-found') notFound();

  if (outcome.kind !== 'loaded') {
    /*
     * **The state first, the likeliest cause second** — the wording every page
     * here has shared since the Phase 0–3 audit, when a signed-out stranger was
     * told a session they never had had expired. And it says nothing has changed,
     * because on the one page that takes money, *"we could not load it"* invites
     * the reading that something happened to the booking.
     */
    return (
      <main className={styles.page}>
        <h1>Your booking</h1>
        <p role="alert" className={styles.problem}>
          {outcome.kind === 'signed-out'
            ? 'You are not signed in. Your session may have expired — '
            : 'This booking could not be loaded just now. Nothing has been cancelled or charged — try again in a moment. '}
          {outcome.kind === 'signed-out' ? <Link href="/sign-in">sign in</Link> : null}
        </p>
        <p className={styles.footnote}>
          <Link href={BOOKINGS_PAGE_PATH}>Back to your bookings</Link>
        </p>
      </main>
    );
  }

  const booking = outcome.value;

  /*
   * **The renter's wording, and the page is right to assume it.** Whoever is
   * reading, this page is about *a hire* — and the owner's own view of a booking
   * on their item is their listing page and the dashboard, which is where 4.6b
   * put answering. The one thing that genuinely differs for an owner is the pay
   * control, and the API decides that.
   */
  const wording = bookingStateWording(booking.state, 'renter');

  return (
    <main className={styles.page}>
      <p className={styles.back}>
        <Link href={BOOKINGS_PAGE_PATH}>← Your bookings</Link>
      </p>

      <div className={styles.head}>
        <h1 className={styles.title}>{booking.itemTitle}</h1>
        <BookingStateLabel state={booking.state} party="renter" />
      </div>

      <p className={styles.category}>{booking.categoryName}</p>

      {wording.meaning === null ? null : (
        <p className={styles.meaning}>{wording.meaning}</p>
      )}

      <p className={styles.period}>
        {Time.formatLocalDate(booking.startDate)} to{' '}
        {Time.formatLocalDate(booking.endDate)}
        <span className={styles.days}>
          {' '}
          · {booking.days} {booking.days === 1 ? 'day' : 'days'}
        </span>
      </p>

      {/*
        **The breakdown, and it is most of why a renter is sent here to pay.**
        `lineItems` is on this projection and on neither list one, so this is the
        only place the figure somebody commits to is shown beside what makes it
        up. §3.4.4 requires the inclusive total wherever a price appears; showing
        the parts as well is what makes it checkable rather than merely correct.

        **The wording of a line comes from `describeLine`**, shared with the quote
        panel — the page where this price was agreed and the page where it is paid
        must not describe it differently.
      */}
      <ul className={styles.lines}>
        {booking.lineItems.map((item, index) => (
          <li key={`${item.unit}-${String(index)}`}>
            <span>{describeLine(item)}</span>
            <span>{Money.format(item.subtotal)}</span>
          </li>
        ))}
        <li>
          <span>Our fee</span>
          <span>{Money.format(booking.renterFee)}</span>
        </li>
        <li className={styles.totalLine}>
          <span>Total</span>
          <span>
            <strong>{Money.format(booking.total)}</strong>
          </span>
        </li>
      </ul>

      <p className={styles.totalNote}>Fees included.</p>

      {/*
        **The figure this booking was made under, not the listing's today**
        (§8.7.2's *"bookings retain the values current at creation"*). The line
        here used to say only that damage security *"is not part of this figure
        and is not taken yet"* — true, and it left a renter with no idea what the
        number would be. It is on the booking now, so it is stated.
      */}
      <DamageHold
        excess={booking.appliedExcess}
        audience={booking.viewer}
        className={styles.hold}
        explainSize
      />

      <BookingPayment booking={booking} />

      <p className={styles.footnote}>
        <Link href={hirePath(booking.listingId)}>See the item</Link> ·{' '}
        <Link href={BOOKINGS_PAGE_PATH}>All your bookings</Link>
      </p>
    </main>
  );
}
