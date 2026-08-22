import { describe, expect, it } from 'vitest';
import { Money } from '@platform/core';
import {
  BASIS_POINTS_PER_UNIT,
  MAX_FEE_BASIS_POINTS,
  MAX_PRICING_FLOOR_MINOR_UNITS,
  RECOMMENDED_OWNER_COMMISSION_BASIS_POINTS,
  RECOMMENDED_RENTER_FEE_BASIS_POINTS,
  MAX_RENTAL_RATE_MINOR_UNITS,
  MAX_DAMAGE_SECURITY_MINOR_UNITS,
  MAX_EXCESS_PERCENTAGE_BASIS_POINTS,
  EXCESS_BOUNDS,
  NO_DAMAGE_SECURITY,
  UNCONFIGURED_FEE_POLICY,
  UNPRICED_RATE_CARD,
  basisPointsToPercent,
  isFeePolicyConfigured,
  parseCategoryFeePolicy,
  parseDamageSecurityPolicy,
  parseListingRateCard,
  appliedExcessOrNoneSchema,
  appliedExcessSchema,
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

const validBand = {
  excessFloor: { amount: 7_500, currency: 'GBP' },
  excessPercentageBasisPoints: 1_500,
  recoveryCeiling: { amount: 50_000, currency: 'GBP' },
};

describe('parseDamageSecurityPolicy', () => {
  it('accepts a configured band', () => {
    const band = parseDamageSecurityPolicy(validBand);

    expect(band).toEqual(validBand);
  });

  /**
   * BRD §8.7.2 permits a category "configured to require no security", so the
   * absence has to be expressible on the write path — ADR 0052.
   */
  it('accepts null, which is a category that requires no security', () => {
    expect(parseDamageSecurityPolicy(null)).toBeNull();
  });

  /**
   * The distinction ADR 0025 keeps paying for. `null` is a decision; omitting
   * the field is a caller that forgot, and the two must not look alike — the
   * schemas that embed this one make it a required field for exactly that
   * reason.
   */
  it('refuses undefined, which is a caller that forgot rather than one that chose', () => {
    expect(() => parseDamageSecurityPolicy(undefined)).toThrow();
  });

  it('refuses a partial band — the invalid middle is unrepresentable', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        recoveryCeiling: { amount: 50_000, currency: 'GBP' },
      }),
    ).toThrow();
  });

  it('accepts a zero floor — a band may be sized entirely from the percentage', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessFloor: { amount: 0, currency: 'GBP' },
      }),
    ).not.toThrow();
  });

  it('accepts a zero percentage — a category of same-valued items is real', () => {
    expect(() =>
      parseDamageSecurityPolicy({ ...validBand, excessPercentageBasisPoints: 0 }),
    ).not.toThrow();
  });

  /**
   * A ceiling of nothing is a band from which nothing is ever recoverable —
   * the no-security case spelled a second way, and two spellings of one state
   * is how they come to be handled differently.
   */
  it('refuses a zero recovery ceiling — that is the no-security case, spelled null', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessFloor: { amount: 0, currency: 'GBP' },
        recoveryCeiling: { amount: 0, currency: 'GBP' },
      }),
    ).toThrow(/at least 1p/);
  });

  it('refuses a negative floor', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessFloor: { amount: -1, currency: 'GBP' },
      }),
    ).toThrow(/at least £0/);
  });

  it('refuses amounts above the platform-wide bound', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        recoveryCeiling: {
          amount: MAX_DAMAGE_SECURITY_MINOR_UNITS + 1,
          currency: 'GBP',
        },
      }),
    ).toThrow(/at most £10000/);
  });

  it('refuses a fractional basis point, which is a percentage sent as a decimal', () => {
    expect(() =>
      parseDamageSecurityPolicy({ ...validBand, excessPercentageBasisPoints: 15.5 }),
    ).toThrow(/whole number of basis points/);
  });

  it('refuses a negative percentage', () => {
    expect(() =>
      parseDamageSecurityPolicy({ ...validBand, excessPercentageBasisPoints: -1 }),
    ).toThrow(/cannot be negative/);
  });

  it('refuses a percentage above 100% — a renter cannot owe more than the item is worth', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessPercentageBasisPoints: MAX_EXCESS_PERCENTAGE_BASIS_POINTS + 1,
      }),
    ).toThrow(/cannot owe more than the item is worth/);
  });

  it('accepts a percentage of exactly 100%', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessPercentageBasisPoints: MAX_EXCESS_PERCENTAGE_BASIS_POINTS,
      }),
    ).not.toThrow();
  });

  /**
   * The pair that would make ADR 0052's cap bind on every listing, turning the
   * percentage into dead configuration — and the one a transposition reaches.
   */
  it('refuses a floor above the recovery ceiling', () => {
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessFloor: { amount: 50_001, currency: 'GBP' },
        recoveryCeiling: { amount: 50_000, currency: 'GBP' },
      }),
    ).toThrow(/always bear more than could ever be recovered/);
  });

  it('accepts a floor exactly equal to the recovery ceiling', () => {
    /*
     * Degenerate but coherent: every listing carries the same excess whatever it
     * is worth. Refusing it would be a commercial opinion in a validator.
     */
    expect(() =>
      parseDamageSecurityPolicy({
        ...validBand,
        excessFloor: { amount: 50_000, currency: 'GBP' },
        recoveryCeiling: { amount: 50_000, currency: 'GBP' },
      }),
    ).not.toThrow();
  });
});

describe('the damage-security default', () => {
  /**
   * What every category version written before slice 5.5a carries. The reason it
   * is not a guessed floor and percentage is in ADR 0052: a backfilled excess
   * would be a liability nobody agreed to, on an immutable row, indistinguishable
   * from one they did.
   */
  it('is no band at all, rather than a zero-sized one', () => {
    expect(NO_DAMAGE_SECURITY).toBeNull();
  });
});

/**
 * The applied excess as it crosses a wire (slice 5.5b-i).
 *
 * `appliedExcessFor` is unit tested in the API against the band; what these pin
 * is the **shape**, because from this slice a page renders it and a page cannot
 * validate what it is handed.
 */
describe('the applied excess', () => {
  const excess = { amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' };

  it('accepts an amount and the bound that decided it', () => {
    expect(appliedExcessSchema.parse(excess)).toEqual(excess);
  });

  /**
   * **The three bounds are a closed set**, so a fourth cannot arrive on a wire
   * and reach a page that has no sentence for it — the same argument the metric
   * label vocabularies make.
   */
  it('refuses a bound nobody defined', () => {
    expect(appliedExcessSchema.safeParse({ ...excess, boundBy: 'vibes' }).success).toBe(
      false,
    );
    expect([...EXCESS_BOUNDS]).toEqual(['floor', 'percentage', 'ceiling']);
  });

  /**
   * **Strict, so the band cannot ride along.** The floor, percentage and ceiling
   * are administrative configuration; a projection that quietly carried them
   * would publish the platform's liability model on every listing page, and a
   * permissive object is how that happens without anybody choosing it.
   */
  it('refuses to carry the band it was derived from', () => {
    expect(
      appliedExcessSchema.safeParse({
        ...excess,
        excessPercentageBasisPoints: 1_500,
      }).success,
    ).toBe(false);
  });

  /**
   * **Null is a value here, not an omission** (ADR 0052) — §8.7.2 permits a
   * category requiring no security, and from 5.5c that is a different fact from
   * a hold that failed.
   */
  it('lets a category say nothing is held', () => {
    expect(appliedExcessOrNoneSchema.parse(null)).toBeNull();
    expect(appliedExcessOrNoneSchema.safeParse(undefined).success).toBe(false);
  });
});
