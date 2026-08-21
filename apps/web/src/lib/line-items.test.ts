import { describe, expect, it } from 'vitest';
import type { QuoteLineItem } from '@platform/contracts';
import { describeLine } from './line-items';

/**
 * How a price breakdown reads (slice 5.2d).
 *
 * **These moved here with the function**, which was private to
 * `request-panel.tsx` until the pay page needed the same words. The page that
 * quotes a price and the page that takes it must describe it identically, and a
 * second copy is how they would come to differ.
 */

const line = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  unit: 'day',
  count: 3,
  unitPrice: { amount: 1_800, currency: 'GBP' },
  subtotal: { amount: 5_400, currency: 'GBP' },
  ...over,
});

describe('describeLine', () => {
  it('counts the units and gives the price of one', () => {
    expect(describeLine(line())).toBe('3 days at £18.00 each');
  });

  /**
   * **No "each" for a single unit.** *"1 week at £45.00 each"* reads as though
   * something were being counted twice, and the unit price and the subtotal are
   * the same number — printing both is noise at the moment somebody is checking
   * a total.
   */
  it('says neither "each" nor a unit price when there is one of them', () => {
    expect(describeLine(line({ unit: 'week', count: 1 }))).toBe('1 week');
  });

  it('pluralises every rental unit the same way', () => {
    expect(describeLine(line({ unit: 'week', count: 2 }))).toContain('2 weeks');
    expect(describeLine(line({ unit: 'day', count: 2 }))).toContain('2 days');
  });
});
