import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import * as T from './time.js';

/** Build an instant from a local London wall-clock time. */
const london = (iso: string): Date =>
  DateTime.fromISO(iso, { zone: T.PLATFORM_TIMEZONE }).toJSDate();

// British Summer Time in 2026: begins Sun 29 March, ends Sun 25 October.
const SPRING_FORWARD = '2026-03-29';
const AUTUMN_BACK = '2026-10-25';

describe('rentalDayCount', () => {
  it('counts calendar days between collection and return', () => {
    // Matches how equipment hire is priced: 27 Jul to 3 Aug is 7 days.
    expect(rentalDays('2026-07-27T09:00', '2026-08-03T09:00')).toBe(7);
  });

  it('bills a same-day rental as one day, never zero', () => {
    expect(rentalDays('2026-07-27T09:00', '2026-07-27T17:00')).toBe(1);
  });

  it('ignores time of day', () => {
    expect(rentalDays('2026-07-27T23:59', '2026-07-28T00:01')).toBe(1);
  });

  it('is unaffected by the 23-hour spring-forward day', () => {
    // 28 Mar 09:00 GMT to 30 Mar 09:00 BST is only 47 elapsed hours.
    // Billing on elapsed time would under-count this to 1 day.
    const start = london('2026-03-28T09:00');
    const end = london('2026-03-30T09:00');
    const elapsedHours = (end.getTime() - start.getTime()) / 3_600_000;

    expect(elapsedHours).toBe(47);
    expect(T.rentalDayCount(start, end)).toBe(2);
  });

  it('is unaffected by the 25-hour autumn-back day', () => {
    // 49 elapsed hours would over-count to 3 days on an elapsed-time model.
    const start = london('2026-10-24T09:00');
    const end = london('2026-10-26T09:00');
    const elapsedHours = (end.getTime() - start.getTime()) / 3_600_000;

    expect(elapsedHours).toBe(49);
    expect(T.rentalDayCount(start, end)).toBe(2);
  });

  it('rejects a return before collection', () => {
    expect(() =>
      T.rentalDayCount(london('2026-07-27T09:00'), london('2026-07-26T09:00')),
    ).toThrow(T.TimeError);
  });

  it('rejects invalid dates', () => {
    expect(() => T.rentalDayCount(new Date('nonsense'), new Date())).toThrow(
      T.TimeError,
    );
  });

  it('rejects an unknown timezone rather than silently using UTC', () => {
    expect(() =>
      T.rentalDayCount(
        london('2026-07-27T09:00'),
        london('2026-07-28T09:00'),
        'Mars/Olympus_Mons',
      ),
    ).toThrow(T.TimeError);
  });

  it('honours a non-default timezone', () => {
    // 27 Jul 23:30 London is 28 Jul 00:30 in Berlin, so the day count differs.
    const start = london('2026-07-27T23:30');
    const end = london('2026-07-28T22:00');
    expect(T.rentalDayCount(start, end, T.PLATFORM_TIMEZONE)).toBe(1);
    expect(T.toLocalDateString(start, 'Europe/Berlin')).toBe('2026-07-28');
  });
});

describe('addRentalDays', () => {
  it('preserves wall-clock time across spring forward', () => {
    // Collected 09:00, due back 09:00 — even though only 23 hours passed.
    const start = london('2026-03-28T09:00');
    const due = T.addRentalDays(start, 1);

    expect(T.formatLocal(due)).toBe('29 Mar 2026, 09:00');
    expect((due.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('preserves wall-clock time across autumn back', () => {
    const start = london('2026-10-24T09:00');
    const due = T.addRentalDays(start, 1);

    expect(T.formatLocal(due)).toBe('25 Oct 2026, 09:00');
    expect((due.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('round-trips with rentalDayCount', () => {
    const start = london('2026-03-27T14:30');
    for (const days of [1, 2, 3, 7, 30, 88]) {
      expect(T.rentalDayCount(start, T.addRentalDays(start, days))).toBe(days);
    }
  });

  it('rejects fractional days', () => {
    expect(() => T.addRentalDays(london('2026-07-27T09:00'), 1.5)).toThrow(T.TimeError);
  });
});

describe('isDstTransitionDay', () => {
  it('detects both UK transitions', () => {
    expect(T.isDstTransitionDay(london(`${SPRING_FORWARD}T12:00`))).toBe(true);
    expect(T.isDstTransitionDay(london(`${AUTUMN_BACK}T12:00`))).toBe(true);
  });

  it('is false on ordinary days', () => {
    expect(T.isDstTransitionDay(london('2026-07-27T12:00'))).toBe(false);
    expect(T.isDstTransitionDay(london('2026-01-15T12:00'))).toBe(false);
  });
});

describe('representation', () => {
  it('serialises to UTC regardless of local offset', () => {
    // 09:00 BST is 08:00Z. Storage must show the UTC instant.
    expect(T.toIsoUtc(london('2026-07-27T09:00'))).toBe('2026-07-27T08:00:00.000Z');
  });

  it('derives the local calendar date, not the UTC one', () => {
    // 00:30 BST on 28 Jul is still 23:30Z on 27 Jul.
    const instant = london('2026-07-28T00:30');
    expect(T.toIsoUtc(instant)).toBe('2026-07-27T23:30:00.000Z');
    expect(T.toLocalDateString(instant)).toBe('2026-07-28');
  });

  it('treats ranges as half-open', () => {
    const start = london('2026-07-27T09:00');
    const end = london('2026-07-28T09:00');
    expect(T.isWithin(start, start, end)).toBe(true);
    expect(T.isWithin(end, start, end)).toBe(false);
  });
});

function rentalDays(startIso: string, endIso: string): number {
  return T.rentalDayCount(london(startIso), london(endIso));
}
