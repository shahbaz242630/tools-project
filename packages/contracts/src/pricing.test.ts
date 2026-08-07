import { describe, expect, it } from 'vitest';
import { Money } from '@platform/core';
import {
  BASIS_POINTS_PER_UNIT,
  MAX_FEE_BASIS_POINTS,
  MAX_PRICING_FLOOR_MINOR_UNITS,
  RECOMMENDED_OWNER_COMMISSION_BASIS_POINTS,
  RECOMMENDED_RENTER_FEE_BASIS_POINTS,
  MAX_RENTAL_RATE_MINOR_UNITS,
  UNCONFIGURED_FEE_POLICY,
  UNPRICED_RATE_CARD,
  basisPointsToPercent,
  isFeePolicyConfigured,
  parseCategoryFeePolicy,
  parseListingRateCard,
} from './pricing.js';

const validPolicy = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
  minimumPlatformFee: { amount: 100, currency: 'GBP' },
};

describe('basisPointsToPercent', () => {
  it('converts to the percentage Money.percentageOf expects', () => {
    expect(basisPointsToPercent(1_500)).toBe(15);
    expect(basisPointsToPercent(800)).toBe(8);
  });

  it('keeps sub-percent granularity, which is why basis points exist', () => {
    expect(basisPointsToPercent(1_250)).toBe(12.5);
  });

  it('agrees with the whole-unit constant', () => {
    expect(basisPointsToPercent(BASIS_POINTS_PER_UNIT)).toBe(100);
  });

  /**
   * The reason this unit was chosen at all. A rate held as `0.15` and
   * multiplied by an amount carries binary floating-point error into money;
   * going through basis points and `Money` keeps every step on integers and a
   * stated rounding mode.
   */
  it('produces an exact fee through Money, where a float rate would not', () => {
    const total = Money.money(1_001, 'GBP');
    const fee = Money.percentageOf(total, basisPointsToPercent(1_500));

    expect(fee).toEqual(Money.money(150, 'GBP'));
    expect(Number.isInteger(fee.amount)).toBe(true);
  });
});

describe('parseCategoryFeePolicy', () => {
  it('accepts a configured policy', () => {
    const policy = parseCategoryFeePolicy(validPolicy);

    expect(policy.ownerCommissionBasisPoints).toBe(1_500);
    expect(policy.renterFeeBasisPoints).toBe(800);
    expect(policy.minimumBookingTotal).toEqual({ amount: 1_000, currency: 'GBP' });
  });

  it('accepts zero rates — a promotional or supply-first category is real', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        ownerCommissionBasisPoints: 0,
        renterFeeBasisPoints: 0,
      }),
    ).not.toThrow();
  });

  it('refuses a fractional basis point, which is a percentage sent as a decimal', () => {
    expect(() =>
      parseCategoryFeePolicy({ ...validPolicy, renterFeeBasisPoints: 8.5 }),
    ).toThrow(/whole number of basis points/);
  });

  /**
   * The mistake this catches is a caller sending `15` meaning 15% and getting
   * 0.15%. It cannot be detected — both are valid basis-point values — which is
   * why `basisPointsToPercent` exists to make the unit visible at the call site
   * rather than why this test exists. What this pins is only that the field
   * refuses a negative.
   */
  it('refuses a negative rate', () => {
    expect(() =>
      parseCategoryFeePolicy({ ...validPolicy, ownerCommissionBasisPoints: -1 }),
    ).toThrow(/cannot be negative/);
  });

  it('refuses a rate above the hard ceiling', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        ownerCommissionBasisPoints: MAX_FEE_BASIS_POINTS + 1,
      }),
    ).toThrow(/hard limit/);
  });

  it('allows a rate outside the recommended band — that band is guidance', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        ownerCommissionBasisPoints:
          RECOMMENDED_OWNER_COMMISSION_BASIS_POINTS.maximum + 500,
        renterFeeBasisPoints: RECOMMENDED_RENTER_FEE_BASIS_POINTS.minimum - 100,
      }),
    ).not.toThrow();
  });

  it('refuses a platform fee floor above the booking floor', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: { amount: 500, currency: 'GBP' },
        minimumPlatformFee: { amount: 600, currency: 'GBP' },
      }),
    ).toThrow(/more than the minimum booking total/);
  });

  /**
   * The message has to name its own subject, because its path never can.
   *
   * `feePolicy.minimumPlatformFee.amount` is three segments of internal
   * structure against a field labelled "Minimum platform fee (£)", so the
   * usual `field: message` rendering names the field twice and once
   * unreadably. 2.4b and 2.4c-i each found that defect; this pins the fix for
   * the nested case, where the path is guaranteed to be meaningless rather than
   * merely likely to be.
   */
  it('names the minimum platform fee in the sentence, not only in the path', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: { amount: 500, currency: 'GBP' },
        minimumPlatformFee: { amount: 600, currency: 'GBP' },
      }),
    ).toThrow(/The minimum platform fee cannot be more than/);
  });

  it('accepts a platform fee floor equal to the booking floor', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: { amount: 500, currency: 'GBP' },
        minimumPlatformFee: { amount: 500, currency: 'GBP' },
      }),
    ).not.toThrow();
  });

  /**
   * The case an administrator actually meets. A fee floor with no booking floor
   * looks harmless and prices a 50p booking at £1 of fees, so the pair has to be
   * decided together — which is why §3.4.2 introduces them together.
   */
  it('refuses a fee floor when no booking floor is set', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: { amount: 0, currency: 'GBP' },
        minimumPlatformFee: { amount: 100, currency: 'GBP' },
      }),
    ).toThrow(/more than the minimum booking total/);
  });

  it('accepts both floors unset, which is what an unpriced category has', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: { amount: 0, currency: 'GBP' },
        minimumPlatformFee: { amount: 0, currency: 'GBP' },
      }),
    ).not.toThrow();
  });

  /**
   * **This passes because of the currency enum, not the cross-field rule.**
   *
   * `SUPPORTED_CURRENCIES` is `['GBP']`, so `EUR` is refused by
   * `currencyCodeSchema` before `checkFloorsAgree` ever runs — which means the
   * mismatch branch in that function is **unreachable today**. Worth stating
   * rather than leaving as a test that looks like it proves something it does
   * not: the day a second currency is supported, that branch starts firing and
   * this test starts proving what its name claims.
   */
  it('refuses a floor in a currency the platform does not support', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumPlatformFee: { amount: 100, currency: 'EUR' },
      }),
    ).toThrow();
  });

  it('refuses a floor above the ceiling', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: {
          amount: MAX_PRICING_FLOOR_MINOR_UNITS + 1,
          currency: 'GBP',
        },
      }),
    ).toThrow(/cannot exceed/);
  });

  it('refuses a negative floor', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumPlatformFee: { amount: -1, currency: 'GBP' },
      }),
    ).toThrow(/cannot be negative/);
  });

  it('refuses a negative booking floor', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumBookingTotal: { amount: -1, currency: 'GBP' },
        minimumPlatformFee: { amount: 0, currency: 'GBP' },
      }),
    ).toThrow(/cannot be negative/);
  });

  it('refuses fractional pence in a floor', () => {
    expect(() =>
      parseCategoryFeePolicy({
        ...validPolicy,
        minimumPlatformFee: { amount: 10.5, currency: 'GBP' },
      }),
    ).toThrow(/whole number of pence/);
  });
});

describe('the unconfigured default', () => {
  it('parses, so a category predating this slice is readable', () => {
    expect(() => parseCategoryFeePolicy(UNCONFIGURED_FEE_POLICY)).not.toThrow();
  });

  it('charges nobody anything rather than guessing a rate', () => {
    expect(UNCONFIGURED_FEE_POLICY.ownerCommissionBasisPoints).toBe(0);
    expect(UNCONFIGURED_FEE_POLICY.renterFeeBasisPoints).toBe(0);
  });

  it('reads as unconfigured', () => {
    expect(isFeePolicyConfigured(UNCONFIGURED_FEE_POLICY)).toBe(false);
  });
});

describe('isFeePolicyConfigured', () => {
  it('is true when either side takes a fee', () => {
    expect(
      isFeePolicyConfigured({ ...UNCONFIGURED_FEE_POLICY, renterFeeBasisPoints: 800 }),
    ).toBe(true);
    expect(
      isFeePolicyConfigured({
        ...UNCONFIGURED_FEE_POLICY,
        ownerCommissionBasisPoints: 1_500,
      }),
    ).toBe(true);
  });

  /**
   * Floors alone do not count. A category with a minimum booking total and no
   * fee on either side has not been through §3.4.3's worked example, and the
   * admin list needs to say so.
   */
  it('is false when only the floors are set', () => {
    expect(
      isFeePolicyConfigured({
        ...UNCONFIGURED_FEE_POLICY,
        minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
      }),
    ).toBe(false);
  });
});

describe('the listing rate card', () => {
  const rates = (over: Record<string, unknown> = {}) => ({
    daily: null,
    weekend: null,
    weekly: null,
    ...over,
  });

  it('accepts a listing nobody has priced', () => {
    expect(() => parseListingRateCard(rates())).not.toThrow();
    expect(() => parseListingRateCard(UNPRICED_RATE_CARD)).not.toThrow();
  });

  it('accepts a daily rate alone', () => {
    expect(() =>
      parseListingRateCard(rates({ daily: { amount: 1_800, currency: 'GBP' } })),
    ).not.toThrow();
  });

  it('accepts all three', () => {
    expect(() =>
      parseListingRateCard({
        daily: { amount: 1_800, currency: 'GBP' },
        weekend: { amount: 3_000, currency: 'GBP' },
        weekly: { amount: 9_000, currency: 'GBP' },
      }),
    ).not.toThrow();
  });

  /**
   * The one real rule. A weekend or weekly rate with no daily rate describes an
   * item rentable for three days but not one, with nothing saying so — the quote
   * engine has no way to express it and 2.8's publication rule would have to
   * invent a meaning for it.
   */
  it('refuses a weekly rate with no daily rate', () => {
    expect(() =>
      parseListingRateCard(rates({ weekly: { amount: 9_000, currency: 'GBP' } })),
    ).toThrow(/daily rate is needed/i);
  });

  it('refuses a weekend rate with no daily rate', () => {
    expect(() =>
      parseListingRateCard(rates({ weekend: { amount: 3_000, currency: 'GBP' } })),
    ).toThrow(/daily rate is needed/i);
  });

  it('refuses a rate below the platform minimum', () => {
    expect(() =>
      parseListingRateCard(rates({ daily: { amount: 99, currency: 'GBP' } })),
    ).toThrow(/at least £1/);
  });

  it('refuses a rate above the platform maximum', () => {
    expect(() =>
      parseListingRateCard(
        rates({ daily: { amount: MAX_RENTAL_RATE_MINOR_UNITS + 1, currency: 'GBP' } }),
      ),
    ).toThrow(/at most/);
  });

  it('refuses fractional pence', () => {
    expect(() =>
      parseListingRateCard(rates({ daily: { amount: 18.5, currency: 'GBP' } })),
    ).toThrow(/whole number of pence/);
  });

  /**
   * Deliberately **not** refused: a weekly rate above seven daily charges. A
   * rate card is the owner's commercial decision, and a validator second-
   * guessing it would hard-code a pricing opinion (§1.2). What is refused is
   * only what cannot be interpreted.
   */
  it('does not second-guess a rate card that is simply expensive', () => {
    expect(() =>
      parseListingRateCard({
        daily: { amount: 1_000, currency: 'GBP' },
        weekend: null,
        weekly: { amount: 100_000, currency: 'GBP' },
      }),
    ).not.toThrow();
  });
});
