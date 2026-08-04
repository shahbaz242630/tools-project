import { describe, expect, it } from 'vitest';
import { readReplacementValue } from './replacement-value';

/**
 * The one money conversion in the web app.
 *
 * Everything here is about the gap between what somebody types and what gets
 * stored. §8.7.1 turns the stored number into a damage excess held on a card, so
 * a value that is wrong by a factor of a hundred is not a display bug.
 */

function accepted(raw: string): number {
  const result = readReplacementValue(raw);
  if (!result.ok)
    throw new Error(`Expected "${raw}" to be accepted: ${result.message}`);
  return result.value.amount;
}

function rejected(raw: string): string {
  const result = readReplacementValue(raw);
  if (result.ok) {
    throw new Error(
      `Expected "${raw}" to be rejected, got ${String(result.value.amount)}`,
    );
  }
  return result.message;
}

describe('pounds to pence', () => {
  it.each([
    ['249.99', 24_999],
    ['249.9', 24_990],
    ['249', 24_900],
    ['0.01', 1],
    ['1000000', 100_000_000],
  ])('reads %s as %i pence', (raw, pence) => {
    expect(accepted(raw)).toBe(pence);
  });

  it('trims surrounding whitespace', () => {
    expect(accepted('  249.99  ')).toBe(24_999);
  });

  it('carries the currency with the amount', () => {
    const result = readReplacementValue('249.99');
    expect(result.ok && result.value.currency).toBe('GBP');
  });
});

describe('what it refuses, and why each one matters', () => {
  it('refuses an empty value rather than reading it as zero', () => {
    expect(rejected('')).toMatch(/give what it would cost/i);
  });

  it('refuses a thousands separator', () => {
    // The dangerous one. `1,299` parsed leniently reads as `1` — a £1,299 item
    // recorded as being worth one pound, and a damage excess to match.
    expect(rejected('1,299')).toMatch(/thousands separator/i);
  });

  it('refuses a currency symbol', () => {
    expect(rejected('£249.99')).toMatch(/digits only/i);
  });

  it('refuses more than two decimal places rather than rounding', () => {
    // Rounding here would be the platform quietly deciding what somebody meant
    // about their own property.
    expect(rejected('249.999')).toBeTruthy();
  });

  it('refuses a negative amount', () => {
    expect(rejected('-249.99')).toBeTruthy();
  });

  it('refuses something that is not a number at all', () => {
    expect(rejected('a lot')).toBeTruthy();
  });

  it('refuses exponent notation', () => {
    // `1e3` is a valid JavaScript number and is not something anybody types
    // into a form meaning £1,000.
    expect(rejected('1e3')).toBeTruthy();
  });

  it('never produces a fractional amount, whatever it accepts', () => {
    for (const raw of ['0.01', '0.10', '1.05', '99.99', '12345.67']) {
      expect(Number.isInteger(accepted(raw))).toBe(true);
    }
  });
});
