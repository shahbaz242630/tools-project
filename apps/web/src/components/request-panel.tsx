'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Money, Time } from '@platform/core';
import type { RentalQuote } from '@platform/contracts';
import { requestPanelAction } from '../app/hire/[id]/actions';
import { INITIAL_REQUEST_STATE } from '../app/hire/[id]/request-state';
import type { RequestPanelState } from '../app/hire/[id]/request-state';
import { hirePath } from '../lib/page-paths';
import { describeLine } from '../lib/line-items';
import styles from './request-panel.module.css';

/**
 * Asking for a price and then for the item (BRD §8.5.2, §8.6, slice 4.5b).
 *
 * **This replaces the sentence that said booking was not open.** Slice 2.10 put
 * a paragraph where a control would go rather than a disabled button, because
 * §15 forbids a control that calls nothing. The control now calls something, so
 * the paragraph goes.
 *
 * **Three steps in one panel, and only one of them is on screen at a time.**
 * Dates and a postcode; then the price those produced; then what was requested.
 * They are exclusive on purpose — a form still showing editable dates beside a
 * quote is a page where somebody can change a date and press *Request this
 * hire*, and be committed to a price computed from a different period. When
 * there is a quote the dates are text, and changing them is a button that says
 * so.
 *
 * **§8.5.2 requires both dates and a postcode before a committed price**, which
 * is why the postcode is asked for here and not made optional. It does not
 * change the total today; it is what makes the quote reproducible, and it is the
 * field that reachability, delivery pricing and location-dependent fees will all
 * read the day any of them exists.
 *
 * **Every date is a `YYYY-MM-DD` string and no `Date` is constructed.** The one
 * instant on the page is the quote's expiry, and it is rendered in the
 * platform's timezone with the timezone said out loud — never in the device's,
 * which is wrong for seven months a year in a way no reviewer sees.
 */
export function RequestPanel({
  listingId,
  today,
}: {
  readonly listingId: string;
  /**
   * The platform's today, as `YYYY-MM-DD`, computed on the server.
   *
   * **A prop rather than a `new Date()` in here**, which is the whole rule of
   * 4.3b restated: this component renders in a browser in an unknown timezone,
   * and "today" is exactly the value that gets that wrong at the edges of a day.
   *
   * It bounds the date controls as a **convenience and not as a control** — the
   * API decides what period it will price, and a browser that ignores `min`
   * gets the same refusal as one that does not.
   */
  readonly today: string;
}) {
  const [state, action, pending] = useActionState(
    requestPanelAction,
    INITIAL_REQUEST_STATE,
  );
  const outcome = useOutcomeFocus(state);

  if (state.status === 'requested') {
    return <RequestSent state={state} anchor={outcome} />;
  }

  return (
    <form action={action} className={styles.panel}>
      <h2 className={styles.heading}>
        {state.status === 'quoted' ? 'Your price' : 'Check dates and price'}
      </h2>

      {/*
        **The focus anchor goes on whatever actually changed, never on a fixed
        empty box.** It was a single wrapper above both branches until reading
        the page found the defect: a successful quote focused a div that only
        ever *contains* the refusal, so a keyboard user got a focus ring painted
        around nothing — a stray blue bar between the heading and the price. The
        ring is right and it was framing the wrong thing.
      */}
      {state.status === 'error' ? (
        <div ref={outcome} tabIndex={-1}>
          <p role="alert" className={styles.error}>
            {state.message}
          </p>
        </div>
      ) : null}

      <input type="hidden" name="listingId" value={listingId} />

      {state.status === 'quoted' ? (
        <Quoted quote={state.quote} pending={pending} anchor={outcome} />
      ) : (
        <Asking submitted={state.submitted} today={today} pending={pending} />
      )}
    </form>
  );
}

/** The three fields §8.5.2 requires before a price may be called committed. */
function Asking({
  submitted,
  today,
  pending,
}: {
  readonly submitted: { startDate: string; endDate: string; postcode: string };
  readonly today: string;
  readonly pending: boolean;
}) {
  return (
    <>
      <div className={styles.dates}>
        <p className={styles.field}>
          <label htmlFor="startDate">First day</label>
          {/*
            `type="date"` submits `YYYY-MM-DD` whatever the display format of the
            reader's locale, which is the format the API takes — so the string
            crosses the wire without anything converting it.

            **`defaultValue` from the action state**, so a refusal keeps what was
            typed. React 19 resets an uncontrolled form once its action
            completes; this codebase has lost somebody's typing that way in
            2.4c-i, 2.5a, 2.7a and 4.3b, and this is the fifth control to be
            written with it in mind rather than after being bitten.
          */}
          <input
            type="date"
            id="startDate"
            name="startDate"
            required
            min={today}
            defaultValue={submitted.startDate}
          />
        </p>
        <p className={styles.field}>
          {/* Inclusive, and labelled as such. "End date" is the word that makes
              somebody wonder whether the last day is included. */}
          <label htmlFor="endDate">Last day</label>
          <input
            type="date"
            id="endDate"
            name="endDate"
            required
            min={today}
            defaultValue={submitted.endDate}
          />
        </p>
      </div>

      <p className={styles.field}>
        <label htmlFor="postcode">Your postcode</label>
        <input
          type="text"
          id="postcode"
          name="postcode"
          required
          autoComplete="postal-code"
          placeholder="BS7 8AA"
          defaultValue={submitted.postcode}
        />
        {/*
          **Said where it is asked for.** A postcode is personal data and the
          reason it is required is not obvious from a price that does not yet
          depend on it — so the sentence says what it is for rather than leaving
          somebody to assume the worst.
        */}
        <small className={styles.hint}>
          Used to work out your price and how far you would travel. It is never shown to
          the owner before you book.
        </small>
      </p>

      <p>
        <button type="submit" name="intent" value="quote" disabled={pending}>
          {pending ? 'Working out your price…' : 'Get a price'}
        </button>
      </p>
      <p className={styles.note}>Getting a price books nothing and costs nothing.</p>
    </>
  );
}

/**
 * The committed total, and the button that asks for it.
 *
 * **The total is the headline and the only figure shown largest** (§3.4.4). The
 * breakdown sits beside it because that section permits a base price shown
 * *alongside* an inclusive total and never instead of one — the same rule the
 * listing's own price block keeps.
 */
function Quoted({
  quote,
  pending,
  anchor,
}: {
  readonly quote: RentalQuote;
  readonly pending: boolean;
  /** Focused when the price arrives, so the ring frames the price. */
  readonly anchor: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={anchor} tabIndex={-1}>
      {/*
        The dates as text, with hidden inputs carrying nothing — the quote id
        lives in the action state, not in the form. There is deliberately no
        editable control here: see the component docblock.
      */}
      <p className={styles.period}>
        {Time.formatLocalDate(quote.startDate)} to {Time.formatLocalDate(quote.endDate)}
        <span className={styles.days}>
          {' '}
          · {quote.days} {quote.days === 1 ? 'day' : 'days'}
        </span>
      </p>

      <p className={styles.total}>
        <span className={styles.totalAmount}>{Money.format(quote.total)}</span> in
        total, fees included
      </p>

      <ul className={styles.lines}>
        {quote.lineItems.map((item, index) => (
          <li key={`${item.unit}-${String(index)}`}>
            <span>{describeLine(item)}</span>
            <span>{Money.format(item.subtotal)}</span>
          </li>
        ))}
        <li>
          <span>Our fee{quote.minimumFeeApplied ? ' (our minimum)' : ''}</span>
          <span>{Money.format(quote.renterFee)}</span>
        </li>
      </ul>

      {/*
        **§3.4.4's damage-security disclosure is deliberately *not* repeated
        here.** It was, and reading the page found the same sentence twice in one
        card about fifteen lines apart, which reads as carelessness rather than
        as emphasis. The listing's own price block carries it directly above this
        panel and is visible at the same time, so the rule is kept once. If this
        panel ever moves out of that card, the sentence comes with it.

        **The quote now carries `appliedExcess` and this still does not render
        it** (slice 5.5b-ii), which is worth stating so it does not look like an
        oversight. The quote *fixes* the figure — the listing page shows the same
        band applied to the same item, from the same request, so the two agree —
        and §8.7.2's *"shown before booking"* is discharged by the block above.
        What the field is for is the **booking**: the page a renter reads
        afterwards is not inside this card, and that is where it is rendered.
      */}
      <p className={styles.expiry}>
        This price holds until{' '}
        <strong>{Time.formatLocal(Time.fromIsoUtc(quote.expiresAt))}</strong> (UK time).
        After that, ask again — the price may have changed.
      </p>

      <p className={styles.actions}>
        <button type="submit" name="intent" value="request" disabled={pending}>
          {pending ? 'Sending your request…' : 'Request this hire'}
        </button>
        {/*
          **A submit button, not a link.** Going back to the fields is a state
          change the server action owns, and it has to put the quote's own dates
          back — a link would reload the page and lose them.
        */}
        <button
          type="submit"
          name="intent"
          value="change"
          /* The global variant from `globals.css`, which is where this
             application's two button variants live — a module class would be a
             second definition of the same thing. */
          className="button-secondary"
          disabled={pending}
        >
          Change dates
        </button>
      </p>
      <p className={styles.note}>
        Requesting is not a booking. The owner has to accept it first, and nothing is
        charged now.
      </p>
    </div>
  );
}

/**
 * What was requested, once it has been.
 *
 * **It promises no notification, because there is none.** Notifications are
 * Phase 6 and there is no email channel, no verified domain and no templates;
 * 4.7 will emit the events and Phase 6 will deliver them. A confirmation saying
 * *"we'll email you"* would be the same class of false sentence the Phase 0–3
 * audit found three of, and this is the most-read page in the product.
 *
 * **It is also not durable, and it says so.** A renter's own view of their
 * requests is 4.8's dashboard; until then this panel is the only place this
 * booking has ever been shown, and somebody who reloads loses it. Saying that is
 * the difference between a known gap and a page that quietly forgets.
 */
function RequestSent({
  state,
  anchor,
}: {
  readonly state: Extract<RequestPanelState, { status: 'requested' }>;
  readonly anchor: RefObject<HTMLDivElement | null>;
}) {
  const { booking } = state;

  return (
    <div className={styles.panel} ref={anchor} tabIndex={-1}>
      <h2 className={styles.heading}>Request sent</h2>

      <p role="status" className={styles.sent}>
        You have asked to hire <strong>{booking.itemTitle}</strong> from{' '}
        {Time.formatLocalDate(booking.startDate)} to{' '}
        {Time.formatLocalDate(booking.endDate)} — {Money.format(booking.total)} in
        total, fees included.
      </p>

      <p className={styles.expiry}>
        The owner has until{' '}
        <strong>{Time.formatLocal(Time.fromIsoUtc(booking.requestExpiresAt))}</strong>{' '}
        (UK time) to accept or decline. Nothing has been charged.
      </p>

      <p className={styles.note}>
        <strong>We cannot tell you their answer yet.</strong> Messages and a page
        listing your bookings are still being built, so nothing will be sent to you and
        this confirmation is not saved anywhere you can return to.
      </p>
    </div>
  );
}

/**
 * What a stranger sees instead of the panel.
 *
 * **`/hire/…` is the one page in this product a signed-out visitor is meant to
 * reach**, and both routes behind the panel need a session. So the choice is
 * made here, before anything is submitted, rather than by letting somebody fill
 * in three fields and meet a refusal — which is exactly the defect the Phase 0–3
 * audit found on the header's primary call to action, where a stranger was told
 * a session they had never had was over.
 *
 * **`redirect_url` brings them back to this listing.** Clerk preserves that
 * parameter through its whole flow, so signing in returns them to the item they
 * were looking at rather than to the home page — which is what
 * `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` would otherwise do.
 */
export function SignInToBook({ listingId }: { readonly listingId: string }) {
  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Check dates and price</h2>
      <p className={styles.body}>
        <Link href={`/sign-in?redirect_url=${encodeURIComponent(hirePath(listingId))}`}>
          Sign in
        </Link>{' '}
        to get a price for your dates and ask the owner to hire this.
      </p>
      <p className={styles.note}>
        You will come straight back here. The price you are shown will include our fee.
      </p>
    </div>
  );
}

/**
 * Move to the outcome rather than leaving it above the fold.
 *
 * **Keyed on the whole state, not on the message.** Two identical refusals
 * compare equal, and an effect that skips the second leaves the page perfectly
 * still exactly when somebody is most likely to conclude it is stuck — the
 * defect 2.4c-ii found in 2.4b's own fix.
 */
function useOutcomeFocus(state: RequestPanelState): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'idle') return;
    anchor.current?.focus();
    // Optional call: jsdom does not implement `scrollIntoView`.
    anchor.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  return anchor;
}
