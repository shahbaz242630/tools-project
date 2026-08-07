import { describe, expect, it } from 'vitest';
import { parseListingRateCard } from '@platform/contracts';
import { poundsOrBlank, readRateCard } from './rate-card';

const blank = { daily: '', weekend: '', weekly: '' };

describe('readRateCard', () => {
  it('reads a full rate card', () => {
    const result = readRateCard({ daily: '18.00', weekend: '30.00', weekly: '90.00' });

    expect(result).toEqual({
      ok: true,
      value: {
        daily: { amount: 1_800, currency: 'GBP' },
        weekend: { amount: 3_000, currency: 'GBP' },
        weekly: { amount: 9_000, currency: 'GBP' },
      },
    });
  });

  it('produces something the contract accepts', () => {
    const result = readRateCard({ daily: '18.00', weekend: '', weekly: '90.00' });
    if (!result.ok) throw new Error(result.message);

    expect(() => parseListingRateCard(result.value)).not.toThrow();
  });

  /**
   * §8.3's "save progress". An unpriced draft is legitimate, and 2.8 is where a
   * missing daily rate becomes a reason not to publish.
   */
  it('reads an empty form as an unpriced listing', () => {
    expect(readRateCard(blank)).toEqual({
      ok: true,
      value: { daily: null, weekend: null, weekly: null },
    });
  });

  it('reads a daily rate alone', () => {
    const result = readRateCard({ ...blank, daily: '18.00' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.daily).toEqual({ amount: 1_800, currency: 'GBP' });
    expect(result.value.weekend).toBeNull();
  });

  it('keeps whole pounds exact', () => {
    const result = readRateCard({ ...blank, daily: '18' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.daily?.amount).toBe(1_800);
  });

  it('refuses a thousands separator, which would read a hundredfold too small', () => {
    expect(readRateCard({ ...blank, daily: '1,299' })).toEqual({
      ok: false,
      message: expect.stringContaining('no thousands separator'),
    });
  });

  it('refuses a currency symbol', () => {
    expect(readRateCard({ ...blank, weekly: '£90.00' })).toEqual({
      ok: false,
      message: expect.stringContaining('digits only'),
    });
  });

  it('refuses fractional pence', () => {
    expect(readRateCard({ ...blank, daily: '18.005' })).toEqual({
      ok: false,
      message: expect.stringContaining('Daily rate'),
    });
  });

  /**
   * The branch the regex cannot catch.
   *
   * `99999999999999999999` is digits only, so the shape check passes — and
   * `Money.fromMajor` refuses it, because the pence value is outside JavaScript's
   * safe integer range. Left to reach the contract it would be a 400 naming a
   * type; caught here it names the field somebody typed in.
   *
   * Worth a test rather than a `c8 ignore`: it is reachable by anybody leaning
   * on a key, which is exactly how a form field gets an absurd value.
   */
  it('refuses an amount too large for exact arithmetic', () => {
    expect(readRateCard({ ...blank, daily: '99999999999999999999' })).toEqual({
      ok: false,
      message: expect.stringContaining('Daily rate'),
    });
  });

  it('names the field that was wrong', () => {
    expect(readRateCard({ daily: '18.00', weekend: 'free', weekly: '' })).toEqual({
      ok: false,
      message: expect.stringContaining('Weekend rate'),
    });
  });

  /**
   * The spine rule lives in the contract, not here — three layers already hold
   * it. What this pins is that the reader does not quietly *pass* it either.
   */
  it('leaves the daily-rate rule to the contract, which still refuses', () => {
    const result = readRateCard({ ...blank, weekly: '90.00' });
    if (!result.ok) throw new Error(result.message);

    expect(() => parseListingRateCard(result.value)).toThrow(/daily rate is needed/i);
  });
});

describe('poundsOrBlank', () => {
  it('renders a rate as pounds', () => {
    expect(poundsOrBlank({ amount: 1_800 })).toBe('18.00');
    expect(poundsOrBlank({ amount: 1_850 })).toBe('18.50');
  });

  it('renders an absent rate as blank rather than as zero', () => {
    expect(poundsOrBlank(null)).toBe('');
  });

  it('round-trips through the reader', () => {
    for (const amount of [100, 1_800, 1_850, 9_000, 123_45]) {
      const result = readRateCard({ ...blank, daily: poundsOrBlank({ amount }) });
      if (!result.ok) throw new Error(result.message);
      expect(result.value.daily?.amount).toBe(amount);
    }
  });
});
