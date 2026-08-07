import { describe, expect, it } from 'vitest';
import { parseCategoryFeePolicy } from '@platform/contracts';
import { percentFromBasisPoints, readFeePolicy } from './fee-policy';

const typed = {
  ownerCommission: '15',
  renterFee: '8',
  minimumBookingTotal: '10.00',
  minimumPlatformFee: '1.00',
};

describe('readFeePolicy', () => {
  it('reads the launch configuration', () => {
    const result = readFeePolicy(typed);

    expect(result).toEqual({
      ok: true,
      value: {
        ownerCommissionBasisPoints: 1_500,
        renterFeeBasisPoints: 800,
        minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
        minimumPlatformFee: { amount: 100, currency: 'GBP' },
      },
    });
  });

  it('produces something the contract accepts', () => {
    const result = readFeePolicy(typed);
    if (!result.ok) throw new Error(result.message);

    expect(() => parseCategoryFeePolicy(result.value)).not.toThrow();
  });

  /**
   * The reason the conversion is done on digits rather than by multiplying.
   * `12.5 * 100` is not reliably 1250 in binary floating point, and the error
   * would be inherited by every booking the rate touches.
   */
  it('converts a fractional percentage exactly', () => {
    const result = readFeePolicy({ ...typed, renterFee: '12.5' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.renterFeeBasisPoints).toBe(1_250);
    expect(Number.isInteger(result.value.renterFeeBasisPoints)).toBe(true);
  });

  it('converts two decimal places exactly', () => {
    const result = readFeePolicy({ ...typed, renterFee: '12.55' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.renterFeeBasisPoints).toBe(1_255);
  });

  it('accepts zero, which is a promotional category rather than a mistake', () => {
    const result = readFeePolicy({ ...typed, ownerCommission: '0', renterFee: '0' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.ownerCommissionBasisPoints).toBe(0);
  });

  it('refuses a third decimal place rather than rounding it away silently', () => {
    expect(readFeePolicy({ ...typed, renterFee: '12.555' })).toEqual({
      ok: false,
      message: expect.stringContaining('at most two decimal places'),
    });
  });

  it('names the % sign specifically, because it is what somebody will type', () => {
    expect(readFeePolicy({ ...typed, renterFee: '8%' })).toEqual({
      ok: false,
      message: expect.stringContaining('without the % sign'),
    });
  });

  it('refuses a rate above the hard ceiling', () => {
    expect(readFeePolicy({ ...typed, ownerCommission: '60' })).toEqual({
      ok: false,
      message: expect.stringContaining('cannot exceed 50%'),
    });
  });

  it('asks for a rate that was left blank', () => {
    expect(readFeePolicy({ ...typed, ownerCommission: '' })).toEqual({
      ok: false,
      message: expect.stringContaining('Owner commission'),
    });
  });

  /**
   * Empty means "no floor" here, unlike an empty rate. A category may
   * legitimately set neither floor, and forcing a 0 to be typed would make the
   * common case the one that needs explaining.
   */
  it('reads an empty floor as no floor', () => {
    const result = readFeePolicy({
      ...typed,
      minimumBookingTotal: '',
      minimumPlatformFee: '',
    });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.minimumBookingTotal.amount).toBe(0);
    expect(result.value.minimumPlatformFee.amount).toBe(0);
  });

  it('refuses a thousands separator, which would read a hundredfold too small', () => {
    expect(readFeePolicy({ ...typed, minimumBookingTotal: '1,299' })).toEqual({
      ok: false,
      message: expect.stringContaining('no thousands separator'),
    });
  });

  it('refuses a currency symbol', () => {
    expect(readFeePolicy({ ...typed, minimumPlatformFee: '£1.00' })).toEqual({
      ok: false,
      message: expect.stringContaining('digits only'),
    });
  });

  /**
   * The cross-field rule is deliberately not enforced here — three other layers
   * hold it. What this pins is that this reader does not quietly *pass* it
   * either: the contract is what refuses, and it still does.
   */
  it('leaves the cross-field rule to the contract, which still refuses', () => {
    const result = readFeePolicy({
      ...typed,
      minimumBookingTotal: '0',
      minimumPlatformFee: '1.00',
    });
    if (!result.ok) throw new Error(result.message);

    expect(() => parseCategoryFeePolicy(result.value)).toThrow(
      /more than the minimum booking total/,
    );
  });
});

describe('percentFromBasisPoints', () => {
  it('renders a whole percentage without a decimal point', () => {
    expect(percentFromBasisPoints(1_500)).toBe('15');
    expect(percentFromBasisPoints(800)).toBe('8');
  });

  it('renders a fractional percentage', () => {
    expect(percentFromBasisPoints(1_250)).toBe('12.5');
    expect(percentFromBasisPoints(1_255)).toBe('12.55');
  });

  it('renders zero', () => {
    expect(percentFromBasisPoints(0)).toBe('0');
  });

  it('round-trips through the reader', () => {
    for (const bp of [0, 800, 1_250, 1_255, 1_500, 5_000]) {
      const result = readFeePolicy({ ...typed, renterFee: percentFromBasisPoints(bp) });
      if (!result.ok) throw new Error(`${String(bp)}: ${result.message}`);
      expect(result.value.renterFeeBasisPoints).toBe(bp);
    }
  });
});
