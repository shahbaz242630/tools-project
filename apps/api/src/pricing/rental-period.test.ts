import { Time } from '@platform/core';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  MAX_MAXIMUM_RENTAL_DAYS,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  describePeriodRefusal,
  refusePeriod,
  rentalPeriodDays,
} from './rental-period.js';

/**
 * The rental period and §8.5.3's cap (slice 4.4a).
 *
 * **The cap is a legal boundary, so the tests that matter most are the ones
 * asserting it cannot be got around** — not by an argument, not by a category's
 * own configuration, and not by the clocks changing.
 */

const LONDON = 'Europe/London';

/**
 * The instant a London calendar day begins.
 *
 * **Built from the time primitive rather than from luxon**, which
 * `packages/core` depends on and `apps/api` deliberately does not — a test that
 * reached past the primitive for its fixtures would be constructing instants by
 * a route the production code is not allowed to use.
 */
const london = (date: string): Date => Time.startOfLocalDay(date, LONDON);

/** `hours` after the start of that London day, for a within-the-day fixture. */
const londonAt = (date: string, hours: number): Date =>
  Time.addHours(london(date), hours);

describe('rentalPeriodDays', () => {
  it('counts the way equipment hire is priced', () => {
    // 27 Jul to 3 Aug is 7 days — the same worked example `rentalDayCount` uses.
    expect(rentalPeriodDays(london('2026-07-27'), london('2026-08-03'), LONDON)).toBe(
      7,
    );
  });

  it('bills a same-day hire as one day, never zero', () => {
    expect(
      rentalPeriodDays(london('2026-07-27'), londonAt('2026-07-27', 8), LONDON),
    ).toBe(1);
  });

  it('is unaffected by either clock change', () => {
    /*
     * The spring day is 23 hours and the autumn day 25, so elapsed-time
     * arithmetic under-counts one and over-counts the other. Both are two days.
     */
    const spring = rentalPeriodDays(london('2026-03-28'), london('2026-03-30'), LONDON);
    const autumn = rentalPeriodDays(london('2026-10-24'), london('2026-10-26'), LONDON);

    expect(spring).toBe(2);
    expect(autumn).toBe(2);
  });

  it('counts in the booking’s own zone, not the platform default', () => {
    // ADR 0003 stores the zone per booking so a rental can be recounted the same
    // way later. A hire late on the 27th in London is already the 28th in Berlin.
    const start = londonAt('2026-07-27', 23);
    const end = londonAt('2026-07-28', 22);

    expect(rentalPeriodDays(start, end, LONDON)).toBe(1);
    expect(rentalPeriodDays(start, end, 'Europe/Berlin')).toBe(1);
    // Same count here, and the dates differ — which is the fact that makes the
    // stored zone load-bearing rather than decorative.
    expect(Time.toLocalDateString(start, 'Europe/Berlin')).toBe('2026-07-28');
  });
});

describe('refusePeriod', () => {
  const start = london('2026-07-01');
  const after = (days: number): Date => Time.addRentalDays(start, days, LONDON);

  it('permits a hire exactly at the cap', () => {
    expect(
      refusePeriod(start, after(88), LONDON, DEFAULT_MAXIMUM_RENTAL_DAYS),
    ).toBeNull();
  });

  it('refuses one day past it', () => {
    // The boundary in the direction that carries the legal consequence.
    expect(refusePeriod(start, after(89), LONDON, DEFAULT_MAXIMUM_RENTAL_DAYS)).toEqual(
      {
        reason: 'over-maximum',
        days: 89,
        maximumDays: 88,
      },
    );
  });

  it('reads the bound from configuration rather than from the constant', () => {
    /*
     * §8.5.3 makes the cap **per category**. A category configured to 30 must
     * refuse 31 — a test that only ever exercised 88 would pass against a
     * hard-coded number, which is the defect this asserts against.
     */
    expect(refusePeriod(start, after(30), LONDON, 30)).toBeNull();
    expect(refusePeriod(start, after(31), LONDON, 30)).toMatchObject({
      reason: 'over-maximum',
      maximumDays: 30,
    });
  });

  it('cannot be widened past the statutory ceiling by configuration', () => {
    /*
     * **The one that matters.** A stored value above 88 — written before the
     * schema existed, or by anything that bypassed it — must not buy a longer
     * hire. The bound is the *lower* of the two, so configuration can narrow it
     * and never widen it.
     */
    expect(refusePeriod(start, after(120), LONDON, 365)).toEqual({
      reason: 'over-maximum',
      days: 120,
      maximumDays: MAX_MAXIMUM_RENTAL_DAYS,
    });
  });

  it('refuses a period that ends before it starts, and one that is instant', () => {
    expect(refusePeriod(after(3), start, LONDON, 88)).toEqual({ reason: 'inverted' });
    expect(refusePeriod(start, start, LONDON, 88)).toEqual({ reason: 'inverted' });
  });

  it('counts the cap in calendar days across a clock change', () => {
    /*
     * An 88-day hire beginning before the autumn transition contains a 25-hour
     * day, so it is 2113 hours rather than 2112. Elapsed-hour arithmetic would
     * make it 88.04 days and refuse a hire the law permits — the failure being
     * a customer told no for a reason that is not true.
     */
    const beforeTheChange = london('2026-09-01');
    const eightyEightDays = Time.addRentalDays(beforeTheChange, 88, LONDON);
    const elapsedHours =
      (eightyEightDays.getTime() - beforeTheChange.getTime()) / 3_600_000;

    expect(elapsedHours).toBe(88 * 24 + 1);
    expect(refusePeriod(beforeTheChange, eightyEightDays, LONDON, 88)).toBeNull();
  });
});

describe('describePeriodRefusal', () => {
  it('names both numbers, because "too long" is not actionable', () => {
    const message = describePeriodRefusal({
      reason: 'over-maximum',
      days: 100,
      maximumDays: 88,
    });

    expect(message).toContain('100 days');
    expect(message).toContain('88');
  });

  it('explains rather than merely refusing', () => {
    /*
     * Somebody asking for a hundred days is not doing anything unreasonable, and
     * a bare "not allowed" reads as an arbitrary limit to argue with. The
     * sentence says whose rule it is — pinned here because it is exactly the
     * kind of copy that gets shortened later by somebody tidying.
     */
    const message = describePeriodRefusal({
      reason: 'over-maximum',
      days: 100,
      maximumDays: 88,
    });

    expect(message).toMatch(/regulated/i);
    expect(message).toMatch(/not authorised/i);
  });

  it('says something different, and true, for an inverted period', () => {
    const message = describePeriodRefusal({ reason: 'inverted' });

    expect(message).toMatch(/after the collection/);
    // It must not mention the cap: the dates are not too long, they are backwards.
    expect(message).not.toMatch(/regulated/i);
  });
});
