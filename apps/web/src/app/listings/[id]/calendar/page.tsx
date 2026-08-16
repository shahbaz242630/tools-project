import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { calendarMonthSchema } from '@platform/contracts';
import { clientIpFrom } from '../../../../lib/client-ip';
import { fetchAvailability } from '../../../../lib/availability';
import { fetchListing } from '../../../../lib/listings';
import { ownerListingPath } from '../../../../lib/page-paths';
import { webEnv } from '../../../../lib/env';
import { AvailabilityCalendar } from '../../../../components/availability-calendar';
import styles from './calendar.module.css';

/** Never prerendered — it is somebody's own diary. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Availability',
  robots: { index: false, follow: false },
};

/**
 * The owner's availability calendar (BRD §8.5, slice 4.3b).
 *
 * **Its own page rather than a panel on the listing.** That page is already the
 * longest in the application and answers a different question — *what is this
 * item and is it live* — where this one answers *when can it be had*. They also
 * change at different rates: a listing is written once and edited rarely, and a
 * calendar is kept.
 *
 * **The month is in the URL**, so a month somebody is looking at can be
 * bookmarked, linked and reached with the back button. It is validated here as a
 * courtesy — the API validates it again, and that is the control.
 */
export default async function CalendarPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const month = monthIn((await searchParams).month);
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  /*
   * **Both reads at once, because neither depends on the other.** The listing is
   * fetched for its title: a calendar page that does not name the item is
   * unreadable for an owner with several, and the alternative — passing the
   * title through the URL — would put a value a caller can set into a heading.
   *
   * Ownership is enforced by the API on *both*, so this page has no check of its
   * own to forget.
   */
  const [listing, calendar] = await Promise.all([
    fetchListing(webEnv().API_BASE_URL, token, id, undefined, clientIp),
    fetchAvailability(webEnv().API_BASE_URL, token, id, month, undefined, clientIp),
  ]);

  // Somebody else's listing answers 404 rather than 403, and this page says the
  // same thing the API did. Rendering "you are not allowed" here would leak the
  // existence the API was careful not to confirm.
  if (calendar.kind === 'not-found' || listing.kind === 'not-found') notFound();

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>
        Availability
        {listing.kind === 'loaded' ? (
          <>
            {' '}
            <span className={styles.item}>— {listing.value.title}</span>
          </>
        ) : null}
      </h1>

      {calendar.kind === 'loaded' ? (
        <AvailabilityCalendar listingId={id} calendar={calendar.value} />
      ) : (
        <Unavailable kind={calendar.kind} />
      )}

      {/*
        **Said once, plainly, rather than drawn as an empty legend.** §8.5 wants
        available, unavailable and booked; nothing can create a booking until
        slice 4.5, so a "booked" key would be empty on every render for every
        owner — a dead control in a colour swatch. The sentence goes when there
        is something to show.
      */}
      <p className={styles.footnote}>
        This shows the dates you have blocked. Bookings are not built yet, so nothing
        else can take a date off this calendar.
      </p>

      <p className={styles.footnote}>
        <Link href={ownerListingPath(id)}>Back to this listing</Link> ·{' '}
        <Link href="/listings">All your listings</Link>
      </p>
    </main>
  );
}

/**
 * The month from the query string, or null for the current one.
 *
 * **Null rather than a month computed here.** Working out what month it is means
 * reading a clock, and the clock this page can reach is the rendering server's
 * — the API resolves the default in the platform's timezone, which is the only
 * place in the system that knows what "this month" means for a booking.
 *
 * An unparseable value is also null rather than an error: somebody who has
 * mangled a URL is better served by the calendar they were looking for than by a
 * page about their query string.
 */
function monthIn(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;

  const parsed = calendarMonthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Every failure gets its own sentence.
 *
 * A single "something went wrong" would make an expired session and an
 * unreachable API look identical, and only one of those is fixed by signing in
 * again.
 */
function Unavailable({ kind }: { readonly kind: string }) {
  if (kind === 'signed-out') {
    // The state first, the likeliest cause second. Claiming an expiry to
    // somebody who never signed in is a lie that costs them a pointless trip
    // through the sign-in page wondering what they lost.
    return (
      <p role="alert">
        You are not signed in. Your session may have expired —{' '}
        <Link href="/sign-in">sign in</Link> to see this calendar.
      </p>
    );
  }

  if (kind === 'forbidden') {
    return (
      <p role="alert">
        Your account is suspended, so this calendar cannot be shown. Everything you have
        blocked is still blocked.
      </p>
    );
  }

  return (
    <p role="alert">
      This calendar could not be loaded. Nothing has been changed — try again in a
      moment.
    </p>
  );
}
