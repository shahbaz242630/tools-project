import { describe, expect, it } from 'vitest';
import * as M from './money.js';

const gbp = (n: number) => M.money(n, 'GBP');

describe('construction', () => {
  it('rejects non-integer minor units', () => {
    expect(() => M.money(10.5, 'GBP')).toThrow(M.MoneyError);
  });

  it('rejects unsafe integers', () => {
    expect(() => M.money(Number.MAX_SAFE_INTEGER + 2, 'GBP')).toThrow(M.MoneyError);
  });

  it('accepts negative amounts for refunds and reversals', () => {
    expect(gbp(-500).amount).toBe(-500);
  });

  it.each([
    ['0', 0],
    ['12.34', 1234],
    ['12.3', 1230],
    ['12', 1200],
    ['-5.00', -500],
    ['0.01', 1],
    [' 7.50 ', 750],
  ])('parses %s as %d pence', (input, expected) => {
    expect(M.fromMajor(input, 'GBP').amount).toBe(expected);
  });

  it.each(['12.345', 'abc', '', '1,234.00', '£12.34', '1e3'])('rejects %s', (input) => {
    expect(() => M.fromMajor(input, 'GBP')).toThrow(M.MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(M.add(gbp(1000), gbp(250)).amount).toBe(1250);
    expect(M.subtract(gbp(1000), gbp(250)).amount).toBe(750);
  });

  it('refuses to mix currencies', () => {
    const eur = { amount: 100, currency: 'EUR' } as unknown as M.Money;
    expect(() => M.add(gbp(100), eur)).toThrow(/Currency mismatch/);
  });

  it('sums an empty list to zero', () => {
    expect(M.sum([], 'GBP').amount).toBe(0);
  });

  it('sums a list of line items', () => {
    const lineItems = [gbp(2500), gbp(375), gbp(1000)];
    expect(M.sum(lineItems, 'GBP').amount).toBe(3875);
  });

  it('negates and takes absolute values', () => {
    expect(M.negate(gbp(500)).amount).toBe(-500);
    expect(M.negate(gbp(-500)).amount).toBe(500);
    expect(M.absolute(gbp(-500)).amount).toBe(500);
    expect(M.absolute(gbp(500)).amount).toBe(500);
  });

  it('rejects a non-finite multiplier', () => {
    expect(() => M.multiply(gbp(100), Number.NaN)).toThrow(M.MoneyError);
    expect(() => M.multiply(gbp(100), Number.POSITIVE_INFINITY)).toThrow(M.MoneyError);
  });

  it('rounds half away from zero, symmetrically for negatives', () => {
    // Math.round alone would give -2 here, making a refund differ from a charge.
    expect(M.multiply(gbp(-5), 0.5).amount).toBe(-3);
    expect(M.multiply(gbp(5), 0.5).amount).toBe(3);
  });

  it('supports floor and ceil rounding', () => {
    expect(M.multiply(gbp(101), 0.5, 'floor').amount).toBe(50);
    expect(M.multiply(gbp(101), 0.5, 'ceil').amount).toBe(51);
  });

  it('calculates a percentage', () => {
    expect(M.percentageOf(gbp(2000), 15).amount).toBe(300);
  });
});

describe('allocate', () => {
  it('never creates a penny from nowhere', () => {
    // £10.05 split 50/50. Rounding each half independently gives 503 + 503 =
    // 1006, inventing a penny and breaking the ledger.
    const [a, b] = M.allocate(gbp(1005), [50, 50]);
    expect(a?.amount).toBe(503);
    expect(b?.amount).toBe(502);
    expect((a?.amount ?? 0) + (b?.amount ?? 0)).toBe(1005);
  });

  it('gives the remainder to the largest share', () => {
    const [ownerShare, platformShare] = M.allocate(gbp(1001), [85, 15]);
    expect(ownerShare?.amount).toBe(851);
    expect(platformShare?.amount).toBe(150);
  });

  it('handles negative amounts symmetrically', () => {
    const shares = M.allocate(gbp(-1005), [50, 50]);
    expect(shares.reduce((t, s) => t + s.amount, 0)).toBe(-1005);
  });

  it('conserves the total across many amounts and splits', () => {
    const splits = [[15, 85], [1, 1, 1], [70, 20, 10], [1], [33, 33, 34]];
    for (let amount = -300; amount <= 300; amount += 1) {
      for (const ratios of splits) {
        const total = M.allocate(gbp(amount), ratios).reduce((t, s) => t + s.amount, 0);
        expect(total).toBe(amount);
      }
    }
  });

  it('rejects degenerate ratios', () => {
    expect(() => M.allocate(gbp(100), [])).toThrow(M.MoneyError);
    expect(() => M.allocate(gbp(100), [0, 0])).toThrow(M.MoneyError);
    expect(() => M.allocate(gbp(100), [-1, 2])).toThrow(M.MoneyError);
  });
});

describe('comparison', () => {
  it('orders amounts', () => {
    expect(M.compare(gbp(100), gbp(200))).toBe(-1);
    expect(M.compare(gbp(200), gbp(100))).toBe(1);
    expect(M.compare(gbp(100), gbp(100))).toBe(0);
  });

  it('treats different currencies as unequal without throwing', () => {
    const eur = { amount: 100, currency: 'EUR' } as unknown as M.Money;
    expect(M.equals(gbp(100), eur)).toBe(false);
  });

  it('exposes sign helpers', () => {
    expect(M.isZero(gbp(0))).toBe(true);
    expect(M.isNegative(gbp(-1))).toBe(true);
    expect(M.isPositive(gbp(1))).toBe(true);
  });

  it('selects max and min', () => {
    expect(M.maxOf(gbp(100), gbp(200)).amount).toBe(200);
    expect(M.minOf(gbp(100), gbp(200)).amount).toBe(100);
  });
});

describe('presentation', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [1234, '12.34'],
    [-1234, '-12.34'],
    [-5, '-0.05'],
  ])('renders %d as %s', (amount, expected) => {
    expect(M.toMajorString(gbp(amount))).toBe(expected);
  });

  it('formats for display', () => {
    expect(M.format(gbp(1234))).toBe('£12.34');
  });

  it('round-trips through fromMajor', () => {
    for (const amount of [0, 1, 99, 100, 12345, -6789]) {
      expect(M.fromMajor(M.toMajorString(gbp(amount)), 'GBP').amount).toBe(amount);
    }
  });
});
