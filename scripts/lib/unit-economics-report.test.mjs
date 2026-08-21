import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LEVELS,
  formatBasisPoints,
  formatMinor,
  meetsMinimumMarginRule,
  renderReport,
} from './unit-economics-report.mjs';

/**
 * The §3.4.3 worked example's reporting half (slice 5.3a).
 *
 * The arithmetic is tested in `apps/api/src/pricing/unit-economics.test.ts`. What
 * is tested here is the part that decides whether the run **fails** — because a
 * gate that reports a problem and exits zero is a gate nobody notices, and this
 * one guards a clause that forbids putting a category in front of the public.
 */

const row = (over = {}) => ({
  grossMinor: 1_000,
  isMinimumBookingTotal: true,
  isMedian: false,
  bookingsPerMonth: 1,
  renterPaysMinor: 1_100,
  renterFeeMinor: 100,
  ownerCommissionMinor: 160,
  ownerProceedsMinor: 840,
  platformRevenueMinor: 260,
  totalCostMinor: 283,
  contributionMarginMinor: -23,
  ...over,
});

const category = (over = {}) => ({
  slug: 'outdoor-gardening',
  versionNumber: 2,
  ownerCommissionBasisPoints: 1_600,
  renterFeeBasisPoints: 800,
  minimumBookingTotalMinor: 1_000,
  minimumPlatformFeeMinor: 100,
  rows: [row()],
  breakEvenBookingsPerMonth: 2,
  floorCostBreakdown: { cardProcessing: 37, payout: 12 },
  ...over,
});

describe('formatMinor', () => {
  it('renders pounds and pence', () => {
    expect(formatMinor(1_000)).toBe('£10.00');
    expect(formatMinor(5)).toBe('£0.05');
    expect(formatMinor(0)).toBe('£0.00');
  });

  /**
   * **Negatives are the whole point of this report**, so they must not render as
   * a stray minus in the wrong place or as an absolute value that reads as profit.
   */
  it('renders a loss as a loss', () => {
    expect(formatMinor(-23)).toBe('-£0.23');
    expect(formatMinor(-238)).toBe('-£2.38');
  });
});

describe('meetsMinimumMarginRule', () => {
  it('fails a category whose margin at the floor is negative', () => {
    const verdict = meetsMinimumMarginRule(category());

    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('needs 2 bookings a month');
  });

  it('passes a category whose margin at the floor is positive', () => {
    expect(
      meetsMinimumMarginRule(
        category({ rows: [row({ contributionMarginMinor: 127 })] }),
      ).passed,
    ).toBe(true);
  });

  /**
   * **Zero passes.** §3.4.3 forbids a *negative* margin; breaking exactly even is
   * not something the specification refuses, and tightening it here would be this
   * script inventing a rule the BRD did not set.
   */
  it('passes a category that breaks exactly even', () => {
    expect(
      meetsMinimumMarginRule(category({ rows: [row({ contributionMarginMinor: 0 })] }))
        .passed,
    ).toBe(true);
  });

  /**
   * **Judged at one booking a month, the level a new marketplace actually has.**
   * A row at a busier level must not be able to satisfy the rule, or the gate
   * would pass by assuming the traction it exists to survive the absence of.
   */
  it('judges the floor at one booking a month, not at a busier level', () => {
    const verdict = meetsMinimumMarginRule(
      category({
        rows: [
          row({ bookingsPerMonth: 1, contributionMarginMinor: -23 }),
          row({ bookingsPerMonth: 4, contributionMarginMinor: 127 }),
        ],
      }),
    );

    expect(verdict.passed).toBe(false);
  });

  it('says so when no owner activity would ever make it positive', () => {
    const verdict = meetsMinimumMarginRule(
      category({
        breakEvenBookingsPerMonth: null,
        rows: [row({ contributionMarginMinor: -238 })],
      }),
    );

    expect(verdict.reason).toContain('no level of owner activity');
  });

  /**
   * **A missing row fails rather than passes.** The alternative — treating "not
   * computed" as "fine" — is the silent-success shape this project refuses
   * everywhere else, and here it would let a category through the one gate that
   * stands between it and the public.
   */
  it('fails closed when the floor was never computed', () => {
    const verdict = meetsMinimumMarginRule(
      category({ rows: [row({ isMinimumBookingTotal: false })] }),
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('could not be checked');
  });
});

describe('renderReport', () => {
  const report = () =>
    renderReport({
      categories: [category()],
      assumptions: [{ field: 'supportPerBooking', basis: 'no support desk exists' }],
      generatedOn: '2026-08-21',
      costModel: [
        {
          field: 'cardProcessing',
          value: '1.5% + £0.20',
          source: '[published](x), read y',
        },
      ],
    });

  it('names the category, its fees and its floors', () => {
    const document = report();

    expect(document).toContain('`outdoor-gardening`');
    expect(document).toContain('16.00%');
    expect(document).toContain('8.00%');
    expect(document).toContain('£10.00');
  });

  it('states the §3.4.3 verdict in the document, not only in the exit code', () => {
    expect(report()).toContain('may not be enabled for public booking');
  });

  /**
   * **The assumptions are published with the numbers.** A model whose guesses are
   * invisible reads as a measurement, which is how a worked example comes to carry
   * more authority than it earned.
   */
  it('publishes every assumption beside the result', () => {
    const document = report();

    expect(document).toContain('Assumptions');
    expect(document).toContain('supportPerBooking');
    expect(document).toContain('no support desk exists');
  });

  it('says why the highest-deposit-band column is absent', () => {
    // §3.4.3 asks for three points and deposit bands do not exist. Silence there
    // would read as an oversight rather than as a known, sequenced gap.
    expect(report()).toContain('Deposit bands do not exist yet');
  });

  it('records that it is generated, so nobody edits it by hand', () => {
    expect(report()).toContain('Do not edit by hand');
  });
});

describe('ACTIVITY_LEVELS', () => {
  /**
   * **Starts at one and rises.** One is the pessimistic case the gate is judged
   * at; the rest exist so a reader can see the curve rather than a single number
   * that hides how sensitive it is to owner activity.
   */
  it('starts at one booking a month and increases', () => {
    expect(ACTIVITY_LEVELS[0]).toBe(1);
    expect([...ACTIVITY_LEVELS].sort((a, b) => a - b)).toEqual([...ACTIVITY_LEVELS]);
  });
});

describe('formatBasisPoints', () => {
  it('renders basis points as a percentage', () => {
    expect(formatBasisPoints(1_600)).toBe('16.00%');
    expect(formatBasisPoints(800)).toBe('8.00%');
    expect(formatBasisPoints(1_050)).toBe('10.50%');
  });

  /**
   * **Exact, because it never divides into a float.** dividing basis points by a hundred and fixing two decimals is
   * the obvious version and the invariant checker refuses it — not because a
   * percentage is money, but because that formatting habit in a file about money teaches the
   * eye that it is fine.
   */
  it('is exact at values a float would round', () => {
    expect(formatBasisPoints(1_005)).toBe('10.05%');
    expect(formatBasisPoints(1)).toBe('0.01%');
    expect(formatBasisPoints(0)).toBe('0.00%');
  });
});
