/**
 * The bookings a person is part of, both ways round (§14's *dashboards for both
 * parties*, slice 4.8b).
 *
 * **This is the page that did not exist for four slices, and its absence was the
 * largest hole in the product.** From 4.5a a booking could be made and from 4.6a
 * accepted, and neither party could see one afterwards: it left the owner's
 * requests panel the moment it was answered, the calendar drew nothing, and
 * 4.5b's confirmation was the only place a renter ever saw theirs — lost on
 * reload. From 4.7b a request could also expire with nothing telling anybody.
 *
 * **Two components rather than one with a `party` prop.** They read different
 * projections, say different things and have different empty states; the only
 * thing they share is a shape, and sharing a shape is what CSS is for. The one
 * thing that genuinely *is* common — what a state means — lives in
 * `booking-state.tsx`, which is where the vocabulary belongs.
 *
 * Presentational and exhaustive, per `ListingList`: adding a case to
 * `ListingOutcome` is a type error here rather than a blank panel. And the
 * distinction that convention exists for matters as much here — **somebody with
 * no bookings and a list that could not be read must not look the same.** "You
 * have not asked to hire anything" is a claim about somebody's account, and
 * rendering it because the API timed out would tell them a confirmed hire had
 * vanished.
 *
 * **No `use client`.** No state, no effects, no handlers.
 */

import Link from 'next/link';
import { Money, Time } from '@platform/core';
import type {
  BookingSummaries,
  BookingSummary,
  OwnerBookings,
  OwnerBookingSummary,
} from '@platform/contracts';
import { BookingStateLabel, bookingStateWording } from './booking-state';
import { bookingDetailPath, hirePath, ownerListingPath } from '../lib/page-paths';
import type { ListingOutcome } from '../lib/listings';
import styles from './booking-list.module.css';

/** What this person asked to hire. */
export function RenterBookings({
  outcome,
}: {
  readonly outcome: ListingOutcome<BookingSummaries>;
}) {
  switch (outcome.kind) {
    case 'loaded':
      return outcome.value.bookings.length === 0 ? (
        <p className={styles.empty}>
          You have not asked to hire anything yet.{' '}
          <Link href="/browse">Find something nearby</Link> and the request will appear
          here.
        </p>
      ) : (
        <>
          <Truncation truncated={outcome.value.truncated} />
          <ul className={styles.list}>
            {outcome.value.bookings.map((booking) => (
              <RenterRow key={booking.id} booking={booking} />
            ))}
          </ul>
        </>
      );

    /*
     * **The state first, the likeliest cause second** — the wording every page
     * in this application shares since the Phase 0–3 audit, when a signed-out
     * stranger was told a session they never had had expired.
     */
    case 'signed-out':
      return (
        <p role="alert" className={styles.problem}>
          You are not signed in. Your session may have expired —{' '}
          <Link href="/sign-in">sign in</Link> to see your bookings.
        </p>
      );

    /*
     * Every remaining kind is a failure to read and they collapse to one
     * sentence, which is `ListingList`'s reasoning: none of them is reachable on
     * a route that takes no body, addresses no single booking and pins no
     * category version, and the sentence a person needs is the same in all of
     * them — *your bookings are still there and we could not fetch them.*
     *
     * Listed rather than defaulted, so a new kind breaks the build here instead
     * of falling into a message about something else.
     */
    case 'forbidden':
    case 'not-found':
    case 'invalid':
    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return (
        <p role="alert" className={styles.problem}>
          Your bookings could not be loaded just now. Nothing has been cancelled or
          changed — try again in a moment.
        </p>
      );

    default: {
      const unhandled: never = outcome;
      return <p role="alert">{String(unhandled)}</p>;
    }
  }
}

/** What is booked on this person's own listings. */
export function OwnerBookingList({
  outcome,
}: {
  readonly outcome: ListingOutcome<OwnerBookings>;
}) {
  switch (outcome.kind) {
    case 'loaded':
      return outcome.value.bookings.length === 0 ? (
        /*
         * **"Nobody has asked to hire your items yet", and not "you have no
         * bookings".** 4.6b shipped an empty state that told an owner nobody had
         * asked immediately after two people had, because the panel only ever
         * knew what was *pending*. This list knows every state, so the sentence
         * is true whenever it renders — but the lesson is why it is worded about
         * what has happened rather than about what is on the page.
         */
        <p className={styles.empty}>
          Nobody has asked to hire your items yet. When somebody does, their request
          appears here and on the item itself.
        </p>
      ) : (
        <>
          <Truncation truncated={outcome.value.truncated} />
          <Waiting bookings={outcome.value.bookings} />
          <ul className={styles.list}>
            {outcome.value.bookings.map((booking) => (
              <OwnerRow key={booking.id} booking={booking} />
            ))}
          </ul>
        </>
      );

    case 'signed-out':
      return (
        <p role="alert" className={styles.problem}>
          You are not signed in. Your session may have expired —{' '}
          <Link href="/sign-in">sign in</Link> to see what is booked.
        </p>
      );

    case 'forbidden':
    case 'not-found':
    case 'invalid':
    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return (
        <p role="alert" className={styles.problem}>
          What is booked on your items could not be loaded just now. Nothing has been
          cancelled or changed — try again in a moment.
        </p>
      );

    default: {
      const unhandled: never = outcome;
      return <p role="alert">{String(unhandled)}</p>;
    }
  }
}

/**
 * One hire, as the person who asked for it reads it.
 *
 * **The item's name is the copy the booking kept, and the link is separate.**
 * §8.2 writes the title onto the booking so it renders after a retitle, a pause
 * or an erasure — but the *link* points at a listing that may since have gone.
 * Rendering the stored words and linking out is what lets a hire stay legible
 * when the page behind it does not.
 */
function RenterRow({ booking }: { readonly booking: BookingSummary }) {
  const wording = bookingStateWording(booking.state, 'renter');

  return (
    <li className={styles.row}>
      <div className={styles.head}>
        <h3 className={styles.item}>
          <Link href={hirePath(booking.listingId)}>{booking.itemTitle}</Link>
        </h3>
        <BookingStateLabel state={booking.state} party="renter" />
      </div>

      <p className={styles.period}>
        {Time.formatLocalDate(booking.startDate)} to{' '}
        {Time.formatLocalDate(booking.endDate)}
        <span className={styles.days}>
          {' '}
          · {booking.days} {booking.days === 1 ? 'day' : 'days'}
        </span>
      </p>

      {/*
        **The inclusive total** (§3.4.4), and the note saying so. The breakdown
        is not on this projection at all, so showing a figure that excludes fees
        is not available here rather than merely discouraged.
      */}
      <p className={styles.money}>
        <strong>{Money.format(booking.total)}</strong>
        <span className={styles.moneyNote}> total, fees included</span>
      </p>

      <p className={styles.category}>{booking.categoryName}</p>

      {/*
        **When it lapses, on the row that is actually waiting** — and its absence
        was found by reading the page rather than by a test. `requestExpiresAt` is
        on this projection and was rendered nowhere, while the owner's panel has
        shown the same deadline since 4.6b. A renter told *"the request expires on
        its own"* and not when is being given half a fact about the only booking
        on this page with a clock running on it.

        **Only while it is still waiting.** On an answered or lapsed booking the
        deadline is history, and the state's own sentence already says what became
        of it.
      */}
      {booking.state === 'REQUESTED' ? (
        <p className={styles.deadline}>
          Expires{' '}
          <strong>{Time.formatLocal(Time.fromIsoUtc(booking.requestExpiresAt))}</strong>{' '}
          (UK time).
        </p>
      ) : null}

      {wording.meaning === null ? null : (
        <p className={styles.meaning}>{wording.meaning}</p>
      )}

      {/*
        **Where the hire is opened, and from 5.2d where it is paid for.**

        **On every row rather than only a payable one**, which is the opposite of
        the deadline above and deliberate for the opposite reason. That line is a
        clock and is noise once it has stopped; this is the way in to the booking
        itself — the breakdown, the history — and a link that appears only
        sometimes teaches somebody the row is not openable the rest of the time.

        **The words do not promise paying**, because for most states it is not
        what happens next, and this row does not know: `payability` is on the
        detail projection and not on this one, on purpose. The page says whether
        there is anything to pay, and it asks the API rather than guessing.
      */}
      <p className={styles.open}>
        <Link href={bookingDetailPath(booking.id)}>See this booking</Link>
      </p>
    </li>
  );
}

/**
 * One booking on this owner's item.
 *
 * **`itemCharge` and no payout, and the renter is not named.** Both are the
 * projection's decisions — argued in `listingRequestSchema` and reused by
 * `ownerBookingSummarySchema` — and both are restated in the copy: the figure
 * says *at your rates*, because §3.4's commission arithmetic is Phase 5 and a
 * number presented as what the owner receives would be a false sentence about
 * money.
 *
 * **The link goes to the owner's own page, not the public one.** From there the
 * requests panel is where a pending one is actually answered, which is 4.6b's
 * and stays 4.6b's — one action, one place.
 */
function OwnerRow({ booking }: { readonly booking: OwnerBookingSummary }) {
  const wording = bookingStateWording(booking.state, 'owner');

  return (
    <li className={styles.row}>
      <div className={styles.head}>
        <h3 className={styles.item}>
          <Link href={ownerListingPath(booking.listingId)}>{booking.itemTitle}</Link>
        </h3>
        <BookingStateLabel state={booking.state} party="owner" />
      </div>

      <p className={styles.period}>
        {Time.formatLocalDate(booking.startDate)} to{' '}
        {Time.formatLocalDate(booking.endDate)}
        <span className={styles.days}>
          {' '}
          · {booking.days} {booking.days === 1 ? 'day' : 'days'}
        </span>
      </p>

      <p className={styles.money}>
        <strong>{Money.format(booking.itemCharge)}</strong>
        <span className={styles.moneyNote}>
          {' '}
          at your rates — before our commission, which is worked out when payments are
          built.
        </span>
      </p>

      {wording.meaning === null ? null : (
        <p className={styles.meaning}>{wording.meaning}</p>
      )}
    </li>
  );
}

/**
 * Where a waiting request is answered — and only when one is (slice 4.8b).
 *
 * **Written because the page said it unconditionally and was read.** The owner's
 * blurb carried *"Open an item to answer a request that is still waiting"* to
 * somebody whose bookings had all been answered: an instruction pointing at
 * nothing, which is the class of defect 4.6b shipped in the other direction when
 * its empty state told an owner nobody had asked immediately after two people
 * had. A count of nought is noise, and noise is what makes a real prompt
 * invisible — the same reasoning `OwnerRequests` uses for §7.1's conflict line.
 *
 * **It points rather than acts.** 4.6b put Accept and Decline on the listing's
 * own page beside §7.1's disclosure of what accepting would displace; a second
 * set of buttons here would be the same action in two places, and this would be
 * the copy without the warning.
 */
function Waiting({ bookings }: { readonly bookings: readonly OwnerBookingSummary[] }) {
  const waiting = bookings.filter((booking) => booking.state === 'REQUESTED').length;
  if (waiting === 0) return null;

  return (
    <p className={styles.waiting} role="note">
      <strong>
        {waiting} {waiting === 1 ? 'request is' : 'requests are'} waiting for you.
      </strong>{' '}
      Open the item to accept or decline.
    </p>
  );
}

/**
 * The bound, said on screen rather than only in a log (ADR 0035).
 *
 * `ListingList`'s wording and its reasoning: a list that quietly stops is one
 * somebody reads as their whole record, and **it offers no way to get in touch,
 * because there is not one** — no contact page, no inbox until Phase 6, and by
 * this platform's own rule no support desk after it. An instruction nobody can
 * follow is worse than an admission.
 */
function Truncation({ truncated }: { readonly truncated: boolean }) {
  if (!truncated) return null;

  return (
    <p role="alert" className={styles.problem}>
      This is not all of them. You have more bookings than this page can show, and there
      is no way to page past it yet — nothing is missing from your account, and nothing
      has been cancelled.
    </p>
  );
}
