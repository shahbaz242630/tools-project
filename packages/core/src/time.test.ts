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

describe('startOfLocalDay', () => {
  it('is midnight in London, not midnight UTC', () => {
    // The whole reason this function exists. During BST the two are an hour
    // apart, so `new Date('2026-08-20')` would put the start of an owner's day
    // at 01:00 — and every period built from it would be a day out at one end.
    expect(T.toIsoUtc(T.startOfLocalDay('2026-08-20'))).toBe(
      '2026-08-19T23:00:00.000Z',
    );
  });

  it('is midnight UTC in winter, when the two agree', () => {
    expect(T.toIsoUtc(T.startOfLocalDay('2026-01-15'))).toBe(
      '2026-01-15T00:00:00.000Z',
    );
  });

  it('round-trips through toLocalDateString on both transition days', () => {
    // The spring-forward day is 23 hours long and the autumn one 25. A start
    // instant that lands on the wrong side of either would come back as the
    // neighbouring date.
    for (const date of [SPRING_FORWARD, AUTUMN_BACK, '2026-07-27', '2026-01-15']) {
      expect(T.toLocalDateString(T.startOfLocalDay(date))).toBe(date);
    }
  });

  it('spans 23 hours across spring forward and 25 across autumn back', () => {
    // What a half-open block of exactly one day is worth in elapsed time.
    // Anything computing a period as `days * 24h` gets both of these wrong.
    const springHours =
      (T.startOfLocalDay('2026-03-30').getTime() -
        T.startOfLocalDay(SPRING_FORWARD).getTime()) /
      3_600_000;
    const autumnHours =
      (T.startOfLocalDay('2026-10-26').getTime() -
        T.startOfLocalDay(AUTUMN_BACK).getTime()) /
      3_600_000;

    expect(springHours).toBe(23);
    expect(autumnHours).toBe(25);
  });

  it('honours a non-default timezone', () => {
    expect(T.toIsoUtc(T.startOfLocalDay('2026-08-20', 'Europe/Berlin'))).toBe(
      '2026-08-19T22:00:00.000Z',
    );
  });

  it('refuses a truncated date rather than reading it as the first of the month', () => {
    // `DateTime.fromISO('2026-08')` is valid and means 1 August, which is how a
    // truncated value becomes a real date three weeks from the intended one.
    expect(() => T.startOfLocalDay('2026-08')).toThrow(T.TimeError);
  });

  it('refuses a date that does not exist, and a loosely written one', () => {
    expect(() => T.startOfLocalDay('2026-02-30')).toThrow(T.TimeError);
    expect(() => T.startOfLocalDay('2026-8-1')).toThrow(T.TimeError);
    expect(() => T.startOfLocalDay('20 August 2026')).toThrow(T.TimeError);
    expect(() => T.startOfLocalDay('')).toThrow(T.TimeError);
  });

  it('refuses an unknown timezone rather than silently using UTC', () => {
    expect(() => T.startOfLocalDay('2026-08-20', 'Mars/Olympus_Mons')).toThrow(
      T.TimeError,
    );
  });
});

describe('addLocalDays', () => {
  it('moves a date by whole calendar days', () => {
    expect(T.addLocalDays('2026-08-20', 1)).toBe('2026-08-21');
    expect(T.addLocalDays('2026-08-20', 3)).toBe('2026-08-23');
    expect(T.addLocalDays('2026-08-20', -1)).toBe('2026-08-19');
  });

  it('crosses month and year boundaries', () => {
    expect(T.addLocalDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(T.addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(T.addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('is unmoved by the clocks changing', () => {
    // Civil arithmetic: the day after the 28th is the 29th whatever the clocks
    // did overnight. This is the distinction from `addRentalDays`.
    expect(T.addLocalDays('2026-03-28', 1)).toBe(SPRING_FORWARD);
    expect(T.addLocalDays('2026-10-24', 1)).toBe(AUTUMN_BACK);
  });

  it('rejects a fractional shift and an unparseable date', () => {
    expect(() => T.addLocalDays('2026-08-20', 1.5)).toThrow(T.TimeError);
    expect(() => T.addLocalDays('nonsense', 1)).toThrow(T.TimeError);
  });
});

describe('addLocalMonths', () => {
  it('moves a date by whole calendar months', () => {
    expect(T.addLocalMonths('2026-08-01', 1)).toBe('2026-09-01');
    expect(T.addLocalMonths('2026-08-01', -1)).toBe('2026-07-01');
    expect(T.addLocalMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(T.addLocalMonths('2026-01-01', -1)).toBe('2025-12-01');
  });

  it('clamps a day the target month does not have', () => {
    // Documented rather than relied on — every caller works from the first.
    expect(T.addLocalMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('rejects a fractional shift and an unparseable date', () => {
    expect(() => T.addLocalMonths('2026-08-01', 0.5)).toThrow(T.TimeError);
    expect(() => T.addLocalMonths('2026-13-01', 1)).toThrow(T.TimeError);
  });
});

describe('formatLocalDate and formatLocalMonth', () => {
  it('renders a date and a month the way a British reader expects', () => {
    expect(T.formatLocalDate('2026-08-20')).toBe('20 Aug 2026');
    expect(T.formatLocalDate('2026-01-01')).toBe('1 Jan 2026');
    expect(T.formatLocalMonth('2026-08')).toBe('August 2026');
  });

  it('does not invent a time of day', () => {
    // The distinction from `formatLocal`: a block runs from a date to a date and
    // was never a moment, so there is no midnight to show or to get wrong.
    expect(T.formatLocalDate('2026-08-20')).not.toContain(':');
  });

  it('rejects a value that is not one', () => {
    expect(() => T.formatLocalDate('2026-08')).toThrow(T.TimeError);
    expect(() => T.formatLocalMonth('2026-13')).toThrow(T.TimeError);
  });
});

describe('weekdayOf', () => {
  it('is Monday-first, as ISO 8601 and a British calendar have it', () => {
    // 17 August 2026 is a Monday. `new Date(…).getDay()` would say 1 for a
    // Monday too — and 0 for the Sunday, which is what shifts a grid by a week.
    expect(T.weekdayOf('2026-08-17')).toBe(1);
    expect(T.weekdayOf('2026-08-20')).toBe(4);
    expect(T.weekdayOf('2026-08-23')).toBe(7);
  });

  it('does not depend on the machine’s timezone', () => {
    // The failure this exists to prevent: read as midnight UTC and rendered in a
    // zone behind it, the 1st becomes the previous month's last day.
    expect(T.weekdayOf('2026-08-01')).toBe(6);
    expect(T.weekdayOf('2026-08-31')).toBe(1);
  });

  it('rejects a date that is not one', () => {
    expect(() => T.weekdayOf('2026-08')).toThrow(T.TimeError);
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

describe('fromIsoUtc', () => {
  it('parses an ISO instant', () => {
    expect(T.toIsoUtc(T.fromIsoUtc('2026-07-15T09:00:00.000Z'))).toBe(
      '2026-07-15T09:00:00.000Z',
    );
  });

  it('reads a bare date as UTC, not as local time', () => {
    // `new Date('2026-07-15')` is UTC but `new Date('2026-07-15T09:00')` is
    // local, so two strings that look equally explicit resolve differently.
    // Pinning the zone is the whole reason this helper exists.
    expect(T.toIsoUtc(T.fromIsoUtc('2026-07-15'))).toBe('2026-07-15T00:00:00.000Z');
  });

  it('round-trips with toIsoUtc', () => {
    const iso = '2026-11-27T23:45:12.345Z';
    expect(T.toIsoUtc(T.fromIsoUtc(iso))).toBe(iso);
  });

  it.each(['', 'not a date', '2026-13-01', 'July 2026'])(
    'throws on %s rather than yielding an Invalid Date',
    (value) => {
      // An Invalid Date propagates silently and surfaces as NaN somewhere
      // unrelated, usually in a total.
      expect(() => T.fromIsoUtc(value)).toThrow(T.TimeError);
    },
  );
});

describe('fromEpochMs', () => {
  it('parses Unix milliseconds as UTC', () => {
    // Clerk's own `created_at` for the one real session on the dev instance.
    expect(T.toIsoUtc(T.fromEpochMs(1785408799422))).toBe('2026-07-30T10:53:19.422Z');
  });

  it('round-trips with getTime', () => {
    const ms = 1785408799422;
    expect(T.fromEpochMs(ms).getTime()).toBe(ms);
  });

  it('accepts the epoch itself rather than treating 0 as absent', () => {
    // `if (!ms)` would reject this, and a falsy check on a numeric timestamp is
    // a bug waiting for the one value that is legitimately zero.
    expect(T.toIsoUtc(T.fromEpochMs(0))).toBe('1970-01-01T00:00:00.000Z');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -Number.MAX_VALUE])(
    'throws on %s rather than yielding an Invalid Date',
    (value) => {
      // NaN is what `Number(undefined)` gives when a provider omits a field it
      // promised, and an Invalid Date surfaces as NaN somewhere unrelated.
      expect(() => T.fromEpochMs(value)).toThrow(T.TimeError);
    },
  );

  it('does not silently accept seconds', () => {
    // 1_785_408_799 seconds and milliseconds are both plausible epochs, 24,000
    // years apart, so this cannot be detected — it is pinned here so that the
    // day somebody passes seconds, the wrong answer is a documented one.
    expect(T.toIsoUtc(T.fromEpochMs(1785408799))).toBe('1970-01-21T15:56:48.799Z');
  });
});
