import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Time } from '@platform/core';
import { readCalendarOccupyingStates } from './search-query.mjs';
import {
  bookingCountOf,
  hireDaysOf,
  isBlocked,
  isBooked,
  MAXIMUM_BOOKINGS_PER_LISTING,
  MAXIMUM_HIRE_DAYS,
  MEASURED_WINDOW,
  parseCalendarShares,
  readBookingStates,
  SEASON_ANCHOR,
  SLOT_COUNT,
  SLOT_DAYS,
  slotOf,
  statePools,
} from './booking-load.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CONTRACT = join(root, 'packages', 'contracts', 'src', 'booking.ts');
const MACHINE = join(root, 'apps', 'api', 'src', 'booking', 'booking-state-machine.ts');

describe('the slot layout (slice 4.9)', () => {
  /**
   * The property the `EXCLUDE` constraint would otherwise enforce for us, at the
   * cost of failing halfway through a fifty-thousand-row seed. Asserted here so
   * a change to `SLOT_STRIDE` or `SLOT_COUNT` fails in milliseconds instead.
   */
  it('never puts two of one listing bookings in the same slot', () => {
    for (let listing = 0; listing < 200; listing += 1) {
      const slots = new Set();
      for (let booking = 0; booking < MAXIMUM_BOOKINGS_PER_LISTING; booking += 1) {
        slots.add(slotOf(listing, booking));
      }
      expect(slots.size).toBe(MAXIMUM_BOOKINGS_PER_LISTING);
    }
  });

  it('never lets a hire run out of its own slot', () => {
    // A hire longer than the slot would reach into the next one, which is how
    // two non-overlapping slots still produce two overlapping bookings.
    expect(MAXIMUM_HIRE_DAYS).toBeLessThan(SLOT_DAYS);

    for (let listing = 0; listing < 200; listing += 1) {
      for (let booking = 0; booking < MAXIMUM_BOOKINGS_PER_LISTING; booking += 1) {
        const days = hireDaysOf(listing, booking);
        expect(days).toBeGreaterThanOrEqual(1);
        expect(days).toBeLessThan(SLOT_DAYS);
      }
    }
  });

  it('gives every booked listing between one and three bookings', () => {
    for (let listing = 0; listing < 200; listing += 1) {
      const count = bookingCountOf(listing);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(MAXIMUM_BOOKINGS_PER_LISTING);
    }
  });

  /**
   * The one that makes the measurement mean anything. If the window sat outside
   * the seeded season both subqueries would match nothing, every listing would
   * look free, and the timing would be of a predicate with no work to do —
   * reported as a gate number.
   */
  it('measures a window that falls inside the seeded season', () => {
    // Through `Time` rather than the `Date` global, which `no-restricted-globals`
    // bans workspace-wide and only exempts `*.test.ts` — not `*.test.mjs`.
    const anchor = Time.fromIsoUtc(`${SEASON_ANCHOR}T00:00:00.000Z`);
    const seasonEnds = Time.fromIsoUtc(
      `${Time.addLocalDays(SEASON_ANCHOR, SLOT_COUNT * SLOT_DAYS)}T00:00:00.000Z`,
    );

    const start = Time.fromIsoUtc(MEASURED_WINDOW.startAt);
    const end = Time.fromIsoUtc(MEASURED_WINDOW.endAt);

    expect(start.getTime()).toBeGreaterThanOrEqual(anchor.getTime());
    expect(end.getTime()).toBeLessThanOrEqual(seasonEnds.getTime());
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  /**
   * The property a trial run had to teach, so it is pinned rather than
   * remembered. Every seeded hire starts at its slot's first instant, so a
   * window opening with a slot overlaps every booking in it whatever its length.
   * Opening mid-slot would catch only the longer hires and quietly couple how
   * hard the filter bites to the duration formula.
   */
  it('opens the measured window exactly on a slot boundary', () => {
    const slotStarts = [...Array(SLOT_COUNT).keys()].map((slot) =>
      Time.addLocalDays(SEASON_ANCHOR, slot * SLOT_DAYS),
    );

    expect(slotStarts).toContain(MEASURED_WINDOW.startAt.slice(0, 10));
  });
});

describe('choosing which listings carry a calendar', () => {
  it('selects exactly the share asked for', () => {
    const booked = [...Array(1000).keys()].filter((i) => isBooked(i, 20));
    const blocked = [...Array(1000).keys()].filter((i) => isBlocked(i, 10));

    expect(booked).toHaveLength(200);
    expect(blocked).toHaveLength(100);
  });

  it('keeps the two sets disjoint', () => {
    // Disjoint by construction rather than by luck: booked takes the bottom of
    // each hundred and blocked the top. A listing that was both would still be
    // legal in the database — an EXCLUDE cannot span two tables — but it would
    // make the two shares mean less than they say.
    const booked = new Set([...Array(1000).keys()].filter((i) => isBooked(i, 60)));
    const blocked = [...Array(1000).keys()].filter((i) => isBlocked(i, 40));

    expect(blocked.some((i) => booked.has(i))).toBe(false);
  });

  it('refuses shares that would overlap', () => {
    expect(() =>
      parseCalendarShares(
        new Map([
          ['booked-percent', '70'],
          ['blocked-percent', '40'],
        ]),
      ),
    ).toThrow(/disjoint/);
  });

  it('refuses a share that is not a whole percent', () => {
    expect(() => parseCalendarShares(new Map([['booked-percent', '12.5']]))).toThrow(
      /whole number/,
    );
    expect(() => parseCalendarShares(new Map([['blocked-percent', '-1']]))).toThrow(
      /whole number/,
    );
  });

  it('defaults to a generous calendar rather than a representative one', () => {
    // Generous is the safe direction: more seeded rows is a slower measured
    // query, and a gate number should err pessimistic.
    expect(parseCalendarShares(new Map())).toEqual({
      bookedPercent: 20,
      blockedPercent: 10,
    });
  });
});

describe('reading the state vocabulary rather than restating it', () => {
  it('lifts every state out of the contract', () => {
    const states = readBookingStates(readFileSync(CONTRACT, 'utf8'));

    expect(states).toContain('DRAFT');
    expect(states).toContain('ACCEPTED');
    expect(states).toContain('CLOSED');
    expect(states.length).toBeGreaterThan(20);
  });

  it('refuses to guess when the contract has moved', () => {
    expect(() => readBookingStates('nothing of the sort')).toThrow(/BOOKING_STATES/);
  });

  it('splits the real vocabulary into two non-empty pools', () => {
    const all = readBookingStates(readFileSync(CONTRACT, 'utf8'));
    const occupying = readCalendarOccupyingStates(readFileSync(MACHINE, 'utf8'));

    const pools = statePools(all, occupying);

    expect(pools.occupying).toHaveLength(9);
    // §7.1 keeps a request off the calendar, so it belongs in the other pool —
    // and seeding it is what gives the state predicate rows to reject.
    expect(pools.other).toContain('REQUESTED');
    expect(pools.other).toContain('DECLINED');
    expect(pools.other).not.toContain('ACCEPTED');
  });

  it('refuses a vocabulary with nothing on either side', () => {
    // An all-occupying calendar makes the state predicate filter nothing; an
    // all-other one makes the subquery match nothing. Both time a query with no
    // work to do.
    expect(() => statePools(['ACCEPTED'], ['ACCEPTED'])).toThrow(/non-occupying/);
    expect(() => statePools(['DECLINED'], ['ACCEPTED'])).toThrow(/occupying/);
  });
});
