'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Time } from '@platform/core';
import { MAX_BLOCK_REASON_LENGTH, firstDayOf, monthOf } from '@platform/contracts';
import type { AvailabilityBlock, ListingAvailability } from '@platform/contracts';
import {
  blockPeriodAction,
  unblockPeriodAction,
} from '../app/listings/[id]/calendar/actions';
import {
  INITIAL_CALENDAR_STATE,
  type CalendarActionState,
} from '../app/listings/[id]/calendar/calendar-state';
import { listingCalendarPath } from '../lib/page-paths';
import styles from './availability-calendar.module.css';

/**
 * The owner's calendar (BRD §8.5, slice 4.3b).
 *
 * **Two renderings of one set of periods, deliberately.** The grid answers
 * *"what does August look like"* at a glance and is the thing §8.5 asks for; the
 * list underneath is where a period can be read in words and removed, and it is
 * the half that works without sight of a grid. Neither is decoration for the
 * other — a calendar with no list has nowhere to put a note or a control, and a
 * list with no calendar makes an owner do the date arithmetic themselves.
 *
 * **Every date here is a string and no `Date` is constructed.** The dates arrive
 * as `YYYY-MM-DD`, are compared as strings — which is exact for that format —
 * and are formatted by the time primitive. A `new Date(…)` anywhere in this file
 * would reinterpret them in the browser's timezone, which is the one thing the
 * whole slice is arranged to prevent.
 *
 * **What it does not show is bookings.** §8.5 names three things — available,
 * unavailable and booked — and nothing can create a booking until slice 4.5, so
 * a "booked" layer would be a legend that is empty on every render for every
 * owner. The page says so in one sentence rather than drawing an empty key.
 */
export function AvailabilityCalendar({
  listingId,
  calendar,
}: {
  readonly listingId: string;
  readonly calendar: ListingAvailability;
}) {
  return (
    <>
      <MonthNav listingId={listingId} month={calendar.month} />
      <MonthGrid month={calendar.month} blocks={calendar.blocks} />
      <BlockPeriodForm listingId={listingId} month={calendar.month} />
      <PeriodList listingId={listingId} blocks={calendar.blocks} />
    </>
  );
}

/** Last month, this month's name, next month. */
function MonthNav({
  listingId,
  month,
}: {
  readonly listingId: string;
  readonly month: string;
}) {
  const previous = monthOf(Time.addLocalMonths(firstDayOf(month), -1));
  const next = monthOf(Time.addLocalMonths(firstDayOf(month), 1));

  return (
    <div className={styles.nav}>
      {/*
        Links rather than buttons, because moving between months is navigation:
        it is bookmarkable, it works with the back button, and it needs no
        JavaScript. The month lives in the query string for the same reason.
      */}
      <Link href={`${listingCalendarPath(listingId)}?month=${previous}`} rel="prev">
        ← {Time.formatLocalMonth(previous)}
      </Link>
      <h2 className={styles.month}>{Time.formatLocalMonth(month)}</h2>
      <Link href={`${listingCalendarPath(listingId)}?month=${next}`} rel="next">
        {Time.formatLocalMonth(next)} →
      </Link>
    </div>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The month as a grid, with the blocked days marked. */
function MonthGrid({
  month,
  blocks,
}: {
  readonly month: string;
  readonly blocks: readonly AvailabilityBlock[];
}) {
  const days = daysOf(month);
  const blocked = blockedDaysIn(blocks);
  // Monday-first, from the ISO weekday: 1 for Monday means no leading blanks.
  const offset = Time.weekdayOf(days[0] ?? firstDayOf(month)) - 1;

  return (
    <div className={styles.grid} role="grid" aria-label={Time.formatLocalMonth(month)}>
      {WEEKDAYS.map((day) => (
        <div key={day} className={styles.weekday} role="columnheader">
          {day}
        </div>
      ))}

      {/* The days of the previous month, as empty cells rather than as dates —
          they belong to another month's calendar and are not this page's to
          describe. */}
      {Array.from({ length: offset }, (_, index) => (
        <div key={`blank-${String(index)}`} className={styles.blank} role="gridcell" />
      ))}

      {days.map((date) => (
        <div
          key={date}
          role="gridcell"
          className={blocked.has(date) ? styles.blockedDay : styles.freeDay}
          /*
            **The state is in the accessible name, not only in the colour.** A
            grid where "unavailable" is a shade of grey says nothing to a screen
            reader and little to anybody who cannot distinguish the two shades.
          */
          aria-label={`${Time.formatLocalDate(date)}: ${
            blocked.has(date) ? 'unavailable' : 'available'
          }`}
        >
          <span aria-hidden="true">{Number(date.slice(8))}</span>
        </div>
      ))}
    </div>
  );
}

/** Declare a period unavailable. */
function BlockPeriodForm({
  listingId,
  month,
}: {
  readonly listingId: string;
  readonly month: string;
}) {
  const [state, action, pending] = useActionState(
    blockPeriodAction,
    INITIAL_CALENDAR_STATE,
  );
  const outcome = useOutcomeFocus(state);

  return (
    <form action={action} className={styles.add}>
      <h3>Block some dates</h3>

      <Outcome anchor={outcome} state={state} />

      <input type="hidden" name="listingId" value={listingId} />

      <div className={styles.dates}>
        <p>
          <label htmlFor="startDate">First day</label>
          {/*
            `type="date"` gives a real date picker on every current browser and
            submits `YYYY-MM-DD` — the format the API takes — whatever the
            display format of the reader's locale. `min`/`max` bound it to the
            month on screen only as a starting point; the control still allows
            any date, because a period can legitimately run past the end of the
            month somebody is looking at.
          */}
          {/*
            **`defaultValue` from the action state, so a refusal keeps what was
            typed.** React 19 resets an uncontrolled form once its action
            completes — right for one that succeeded, and how 2.4c-i, 2.5a and
            2.7a each lost somebody's work. Found here by pressing the button
            and watching two dates vanish behind the explanation of why they
            were wrong.
          */}
          <input
            type="date"
            id="startDate"
            name="startDate"
            required
            defaultValue={state.submitted.startDate}
          />
        </p>
        <p>
          <label htmlFor="endDate">Last day</label>
          {/* Inclusive, and labelled as such. "End date" is the word that makes
              somebody wonder whether the last day is included. */}
          <input
            type="date"
            id="endDate"
            name="endDate"
            required
            defaultValue={state.submitted.endDate}
          />
        </p>
      </div>

      <p>
        <label htmlFor="reason">A note, just for you (optional)</label>
        <input
          type="text"
          id="reason"
          name="reason"
          maxLength={MAX_BLOCK_REASON_LENGTH}
          placeholder="Away, being serviced, lent to a friend…"
          defaultValue={state.submitted.reason}
        />
        {/*
          **Said on the form, where the decision to write it is made.** The
          promise is real — no route serves this to anybody else — and somebody
          typing "away until the 14th" is entitled to know that before they type
          it rather than after.
        */}
        <small>
          Only you ever see this. Anybody looking to rent the item is told the dates are
          unavailable, never why.
        </small>
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Blocking…' : 'Block these dates'}
        </button>
      </p>
      <p className={styles.note}>
        Blocked dates cannot be booked. You can remove a period whenever you like, and
        nothing about your listing changes — it stays{' '}
        {/* The reassurance that matters on a control like this: it is not a
            pause, and it is not visible to anybody as a change to the item. */}
        exactly as it is for every other date. Showing {Time.formatLocalMonth(month)}.
      </p>
    </form>
  );
}

/** The periods themselves, in words, each with its own remove control. */
function PeriodList({
  listingId,
  blocks,
}: {
  readonly listingId: string;
  readonly blocks: readonly AvailabilityBlock[];
}) {
  if (blocks.length === 0) {
    return (
      <p className={styles.empty} role="status">
        Nothing is blocked in this month, so every date is available to book.
      </p>
    );
  }

  return (
    <ul className={styles.periods}>
      {blocks.map((block) => (
        <li key={block.id} className={styles.period}>
          <div>
            <strong>{describePeriod(block)}</strong>
            {block.reason === null ? null : (
              <>
                <br />
                <span className={styles.reason}>{block.reason}</span>
              </>
            )}
          </div>
          <RemoveControl listingId={listingId} block={block} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One period's remove button, with its own action state.
 *
 * **Its own component per row**, which is `PublishListingForm`'s arrangement and
 * for its reason: one shared state would leave a refusal from the row somebody
 * pressed a minute ago sitting under a different period.
 */
function RemoveControl({
  listingId,
  block,
}: {
  readonly listingId: string;
  readonly block: AvailabilityBlock;
}) {
  const [state, action, pending] = useActionState(
    unblockPeriodAction,
    INITIAL_CALENDAR_STATE,
  );
  const outcome = useOutcomeFocus(state);

  return (
    <form action={action}>
      <Outcome anchor={outcome} state={state} />
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="blockId" value={block.id} />
      <button type="submit" disabled={pending}>
        {/* The dates are in the accessible name because "Remove" repeated five
            times down a page tells a screen-reader user nothing about which. */}
        <span aria-hidden="true">{pending ? 'Removing…' : 'Remove'}</span>
        <span className={styles.hiddenLabel}>
          {pending ? 'Removing' : 'Remove'} {describePeriod(block)}
        </span>
      </button>
    </form>
  );
}

/** What the last attempt did, or nothing at all. */
function Outcome({
  anchor,
  state,
}: {
  readonly anchor: RefObject<HTMLDivElement | null>;
  readonly state: CalendarActionState;
}) {
  return (
    <div ref={anchor} tabIndex={-1}>
      {state.status === 'error' ? (
        <p role="alert" className={styles.error}>
          {state.message}
        </p>
      ) : null}
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
function useOutcomeFocus(state: CalendarActionState): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'idle') return;
    anchor.current?.focus();
    // Optional call: jsdom does not implement `scrollIntoView`.
    anchor.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  return anchor;
}

/** "20–22 Aug 2026", or one date when the period is a single day. */
function describePeriod(block: AvailabilityBlock): string {
  const from = Time.formatLocalDate(block.startDate);
  if (block.startDate === block.endDate) return from;

  return `${from} to ${Time.formatLocalDate(block.endDate)}`;
}

/** Every date in the month, as `YYYY-MM-DD`. */
function daysOf(month: string): readonly string[] {
  const days: string[] = [];
  let date = firstDayOf(month);

  while (monthOf(date) === month) {
    days.push(date);
    date = Time.addLocalDays(date, 1);
  }

  return days;
}

/**
 * Which individual days any period covers.
 *
 * **Expanded from the inclusive pair the API sends**, so a block that started
 * last month shades the first days of this one. It walks rather than compares
 * ranges because the grid asks about one day at a time, and a set lookup is what
 * keeps that from being quadratic in a month with a lot of periods.
 */
function blockedDaysIn(blocks: readonly AvailabilityBlock[]): ReadonlySet<string> {
  const days = new Set<string>();

  for (const block of blocks) {
    let date = block.startDate;
    // String comparison is date comparison for `YYYY-MM-DD`, and the end is
    // inclusive — the day the owner named is blocked.
    while (date <= block.endDate) {
      days.add(date);
      date = Time.addLocalDays(date, 1);
    }
  }

  return days;
}
