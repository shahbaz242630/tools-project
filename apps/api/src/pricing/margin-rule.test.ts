import { describe, expect, it } from 'vitest';
import type { CategoryFeePolicy } from '@platform/contracts';
import { UK_STRIPE_COST_MODEL } from './cost-model.js';
import {
  NO_FLOOR_PROBE,
  RULE_ACTIVITY_LEVEL,
  marginVerdictFor,
  meetsMarginRule,
} from './margin-rule.js';

/**
 * BRD §3.4.3's binding clause (slice 5.3b).
 *
 * **The numbers here are the ones actually configured**, not invented ones.
 * `outdoor-gardening` and `power-tools` were both reconfigured on 21 August 2026
 * *because* `scripts/unit-economics.mjs` found them losing money at their floors,
 * and a test that proved the rule against made-up rates would not notice if the
 * real ones drifted back.
 */

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

/** `outdoor-gardening` version 5, as configured. */
const GARDENING: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_600,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: gbp(1_000),
  minimumPlatformFee: gbp(200),
};

/** `power-tools` version 4, as configured. */
const POWER_TOOLS: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_800,
  renterFeeBasisPoints: 1_000,
  minimumBookingTotal: gbp(1_000),
  minimumPlatformFee: gbp(200),
};

describe('§3.4.3 at the minimum booking total', () => {
  it('passes both categories as they are actually configured', () => {
    // If this fails, either the fees have been changed to something §3.4.3
    // forbids or the cost model has moved under them. Both are findings.
    expect(meetsMarginRule(GARDENING).meetsRule).toBe(true);
    expect(meetsMarginRule(POWER_TOOLS).meetsRule).toBe(true);
  });

  it('refuses the fees these categories carried before 21 August 2026', () => {
    /*
     * **The real regression, not a hypothetical one.** A £1 minimum platform fee
     * was what both categories had when `unit-economics.mjs` first ran and found
     * them losing money at their floors. This is the state the rule exists to
     * make unreachable.
     */
    const before: CategoryFeePolicy = { ...GARDENING, minimumPlatformFee: gbp(100) };

    const verdict = meetsMarginRule(before);

    expect(verdict.meetsRule).toBe(false);
    expect(verdict.reason).toMatch(/minimum booking total of £10\.00/);
    expect(verdict.reason).toMatch(/loses £/);
  });

  it('judges at the floor, and says which figure it used', () => {
    const verdict = meetsMarginRule(GARDENING);

    expect(verdict.judgedAt).toEqual(gbp(1_000));
  });

  it('refuses a category with no minimum booking total, and says why', () => {
    /*
     * §3.4.3 cannot literally be evaluated with no floor — there is no "minimum
     * booking total" — so the rule reads it as: nothing stops an arbitrarily
     * small booking. **The sentence has to differ from the one above**, because
     * the fix is different: set a floor, rather than raise the fees.
     */
    const noFloor: CategoryFeePolicy = { ...GARDENING, minimumBookingTotal: gbp(0) };

    const verdict = meetsMarginRule(noFloor);

    expect(verdict.meetsRule).toBe(false);
    expect(verdict.judgedAt).toEqual(NO_FLOOR_PROBE);
    expect(verdict.reason).toMatch(/sets no minimum booking total/);
    expect(verdict.reason).not.toMatch(/at its minimum booking total/);
  });

  it('judges at one booking a month, which is the pessimistic level', () => {
    /*
     * Stripe Connect's £2 per active connected account is amortised across an
     * owner's bookings, so a busier assumption passes the gate by assuming the
     * traction the gate exists to survive the absence of. This pins the constant
     * rather than the arithmetic: raising it would silently weaken the rule.
     */
    expect(RULE_ACTIVITY_LEVEL).toBe(1);
  });

  it('takes the cost model, so the rule can be judged against a different one', () => {
    // Not decoration: it is what lets this file prove the rule rather than the
    // cost model, and what makes a non-UK model a parameter rather than a fork.
    const verdict = marginVerdictFor(GARDENING, UK_STRIPE_COST_MODEL);

    expect(verdict).toEqual(meetsMarginRule(GARDENING));
  });

  it('reports a margin whether it passes or fails', () => {
    // The number is what an administrator needs to know how far off they are.
    expect(meetsMarginRule(GARDENING).contributionMargin.currency).toBe('GBP');
    expect(
      meetsMarginRule({ ...GARDENING, minimumPlatformFee: gbp(100) }).contributionMargin
        .amount,
    ).toBeLessThan(0);
  });
});
