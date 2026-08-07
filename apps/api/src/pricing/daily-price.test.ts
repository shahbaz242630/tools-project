import { describe, expect, it } from 'vitest';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import { UNCONFIGURED_FEE_POLICY, UNPRICED_RATE_CARD } from '@platform/contracts';
import { inclusiveDailyPrice } from './daily-price.js';

/** The launch configuration: 15% owner, 8% renter, £10 minimum, £1 fee floor. */
const POLICY: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
  minimumPlatformFee: { amount: 100, currency: 'GBP' },
};

const at = (pence: number): ListingRateCard => ({
  daily: { amount: pence, currency: 'GBP' },
  weekend: null,
  weekly: null,
});

const pence = (money: { readonly amount: number } | undefined) => money?.amount;

describe('an unpriced listing', () => {
  it('has no price rather than a free one', () => {
    expect(inclusiveDailyPrice(UNPRICED_RATE_CARD, POLICY)).toBeNull();
  });

  /**
   * A weekly rate with no daily one cannot happen — the contract refuses it —
   * but this module must not depend on that to avoid returning a wrong number.
   */
  it('has no price when only a weekly rate is set', () => {
    expect(
      inclusiveDailyPrice(
        { daily: null, weekend: null, weekly: { amount: 5_000, currency: 'GBP' } },
        POLICY,
      ),
    ).toBeNull();
  });
});

describe('the inclusive daily price', () => {
  it('adds the renter fee to the rate', () => {
    const price = inclusiveDailyPrice(at(2_500), POLICY);

    // £25.00 + 8% = £2.00 → £27.00
    expect(pence(price?.rate)).toBe(2_500);
    expect(pence(price?.renterFee)).toBe(200);
    expect(pence(price?.total)).toBe(2_700);
    expect(price?.minimumFeeApplied).toBe(false);
  });

  it('always has a total equal to the sum of its parts', () => {
    // The property that a second rounding downstream would break.
    for (const rateInPence of [100, 999, 1_001, 1_234, 2_500, 9_999, 123_45]) {
      const price = inclusiveDailyPrice(at(rateInPence), POLICY);
      if (price === null) throw new Error('expected a price');

      expect(price.total.amount).toBe(price.rate.amount + price.renterFee.amount);
      expect(Number.isInteger(price.total.amount)).toBe(true);
    }
  });

  /**
   * The rounding rule, exercised where it actually decides something.
   *
   * **Every rate here has to clear the £1 floor**, or the floor decides the
   * answer and the test says nothing about rounding — which is how the first
   * draft of these two managed to assert the wrong numbers. At 8% that means
   * above £12.50.
   *
   * 8% of £15.43 is 123.44p → 123p. 8% of £15.44 is 123.52p → 124p. One place,
   * one mode, stated in `Money` and applied here (§6.1). A presentation layer
   * formatting 123.44 to two places would show 123p *and* leave the total
   * disagreeing with the sum of its parts.
   */
  it('rounds the fee half-up to a whole penny, once', () => {
    const down = inclusiveDailyPrice(at(1_543), POLICY);
    expect(pence(down?.renterFee)).toBe(123);
    expect(pence(down?.total)).toBe(1_666);

    const up = inclusiveDailyPrice(at(1_544), POLICY);
    expect(pence(up?.renterFee)).toBe(124);
    expect(pence(up?.total)).toBe(1_668);
  });

  /**
   * An exact half-penny, which 8% cannot produce from a whole number of pence —
   * `rate × 0.08 = n + 0.5` has no integer solution. A 50% rate can, so the
   * mode is pinned with a policy chosen to reach the boundary rather than with
   * the launch rate that cannot.
   */
  it('rounds a half-penny up rather than to even', () => {
    const half: CategoryFeePolicy = { ...POLICY, renterFeeBasisPoints: 5_000 };

    // 50% of £13.01 is 650.5p exactly. Half-up gives 651, banker's would give 650.
    expect(pence(inclusiveDailyPrice(at(1_301), half)?.renterFee)).toBe(651);
    // And 50% of £13.03 is 651.5p → 652, not 651.
    expect(pence(inclusiveDailyPrice(at(1_303), half)?.renterFee)).toBe(652);
  });
});

describe('the minimum platform fee', () => {
  /**
   * §3.4.2's reason for existing: on a cheap booking the percentage does not
   * cover the fixed card and payout costs.
   */
  it('replaces the percentage when the percentage is smaller', () => {
    // 8% of £6.00 is 48p, below the £1.00 floor.
    const price = inclusiveDailyPrice(at(600), POLICY);

    expect(pence(price?.renterFee)).toBe(100);
    expect(pence(price?.total)).toBe(700);
    expect(price?.minimumFeeApplied).toBe(true);
  });

  it('does not apply when the percentage clears it', () => {
    // 8% of £12.50 is £1.00 exactly — equal is not below.
    const price = inclusiveDailyPrice(at(1_250), POLICY);

    expect(pence(price?.renterFee)).toBe(100);
    expect(price?.minimumFeeApplied).toBe(false);
  });

  /**
   * The displayed figure must never be less than what a one-day booking
   * actually costs, which is the whole reason the floor is applied to a
   * *daily* headline at all. Understating is the §3.4.4 exposure; a longer
   * rental costing less per day is what "from" means.
   */
  it('never displays less than a one-day booking would cost', () => {
    for (const rateInPence of [100, 200, 500, 600, 1_000, 1_249]) {
      const price = inclusiveDailyPrice(at(rateInPence), POLICY);
      if (price === null) throw new Error('expected a price');

      expect(price.renterFee.amount).toBeGreaterThanOrEqual(
        POLICY.minimumPlatformFee.amount,
      );
    }
  });

  it('is inert when the category sets no floor', () => {
    const noFloor: CategoryFeePolicy = {
      ...POLICY,
      minimumBookingTotal: { amount: 0, currency: 'GBP' },
      minimumPlatformFee: { amount: 0, currency: 'GBP' },
    };
    const price = inclusiveDailyPrice(at(600), noFloor);

    expect(pence(price?.renterFee)).toBe(48);
    expect(price?.minimumFeeApplied).toBe(false);
  });
});

describe('an unpriced category', () => {
  /**
   * A category configured before slice 2.7a charges nothing, and that must show
   * the rate unchanged rather than fail. §8.2 stops such a category reaching a
   * renter; nothing stops an owner drafting a listing in one.
   */
  it('charges nothing and still produces a total', () => {
    const price = inclusiveDailyPrice(at(2_500), UNCONFIGURED_FEE_POLICY);

    expect(pence(price?.renterFee)).toBe(0);
    expect(pence(price?.total)).toBe(2_500);
    expect(price?.minimumFeeApplied).toBe(false);
  });
});

describe('the currency', () => {
  it('travels with every amount', () => {
    const price = inclusiveDailyPrice(at(2_500), POLICY);

    expect(price?.rate.currency).toBe('GBP');
    expect(price?.renterFee.currency).toBe('GBP');
    expect(price?.total.currency).toBe('GBP');
  });

  /**
   * `Money.add` refuses a mismatched pair, so a listing priced in one currency
   * under a policy floored in another fails loudly rather than adding pence to
   * cents. Unreachable today — one supported currency — and the assertion is
   * what will catch it the day there are two.
   */
  it('refuses to mix currencies rather than adding them', () => {
    const mismatched: CategoryFeePolicy = {
      ...POLICY,
      // Past the contract deliberately: this is what the *module* does when
      // handed a pair the contract would have refused.
      minimumPlatformFee: { amount: 100, currency: 'USD' as 'GBP' },
    };

    expect(() => inclusiveDailyPrice(at(600), mismatched)).toThrow();
  });
});
