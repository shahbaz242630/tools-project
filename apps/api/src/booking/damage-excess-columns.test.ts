import { describe, expect, it } from 'vitest';
import { damageExcessColumns, toAppliedExcess } from './damage-excess-columns.js';

/**
 * §8.7.2's applied excess as two nullable columns (slice 5.5b-ii).
 *
 * **These are the tests the database cannot write.**
 * `quote_damage_excess_is_complete` makes the half-filled pair unstorable, so a
 * `.db.test.ts` can prove the CHECK refuses it — and can never reach the throws
 * here, which exist for a row written *around* the constraint by some future
 * migration, a manual fix, or a restore from a database that predates it.
 */
describe('toAppliedExcess', () => {
  it('reads the pair as an excess, denominated in the row’s currency', () => {
    expect(
      toAppliedExcess(
        { damageExcessAmount: 7_500, damageExcessBoundBy: 'floor', currency: 'GBP' },
        'Quote q1',
      ),
    ).toEqual({ amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' });
  });

  /**
   * **Null is "no security required", never zero** (ADR 0052). §8.7.2 requires a
   * deliberately unsecured handover to be distinguishable from one whose hold
   * failed, which 5.5c depends on.
   */
  it('reads two nulls as no security at all', () => {
    expect(
      toAppliedExcess(
        { damageExcessAmount: null, damageExcessBoundBy: null, currency: 'GBP' },
        'Quote q1',
      ),
    ).toBeNull();
  });

  /**
   * **A zero hold is a figure and must not read as an absence.** A band with a
   * zero floor against a nearly worthless item rounds to nothing — so the branch
   * is on `null` and never on falsiness, which is the mistake this pins.
   */
  it('tells a zero hold apart from no hold', () => {
    expect(
      toAppliedExcess(
        { damageExcessAmount: 0, damageExcessBoundBy: 'floor', currency: 'GBP' },
        'Quote q1',
      ),
    ).toEqual({ amount: { amount: 0, currency: 'GBP' }, boundBy: 'floor' });
  });

  it('refuses an amount with no bound, naming the row', () => {
    expect(() =>
      toAppliedExcess(
        { damageExcessAmount: 7_500, damageExcessBoundBy: null, currency: 'GBP' },
        'Quote q1',
      ),
    ).toThrow(/Quote q1 has a damage excess amount with no bound/);
  });

  /**
   * **A bound from a later build fails loudly rather than rendering as
   * something it is not.** These rows outlive the code that wrote them, which is
   * the same argument that closes the vocabulary in the CHECK.
   */
  it('refuses a bound this build does not know', () => {
    expect(() =>
      toAppliedExcess(
        { damageExcessAmount: 7_500, damageExcessBoundBy: 'vibes', currency: 'GBP' },
        'Booking b1',
      ),
    ).toThrow(/Booking b1 has a damage excess bound this build does not know: vibes/);
  });

  /**
   * A hold in a currency `Money` cannot do arithmetic in is an amount nothing
   * can authorise, and §8.7.1 makes the held figure a hard ceiling on recovery.
   */
  it('refuses an unsupported currency', () => {
    expect(() =>
      toAppliedExcess(
        { damageExcessAmount: 7_500, damageExcessBoundBy: 'floor', currency: 'EUR' },
        'Quote q1',
      ),
    ).toThrow(/EUR/);
  });
});

describe('damageExcessColumns', () => {
  it('writes the pair', () => {
    expect(
      damageExcessColumns({
        amount: { amount: 13_500, currency: 'GBP' },
        boundBy: 'percentage',
      }),
    ).toEqual({ damageExcessAmount: 13_500, damageExcessBoundBy: 'percentage' });
  });

  /** Two nulls, not a zero — the write side of ADR 0052. */
  it('writes two nulls for no security', () => {
    expect(damageExcessColumns(null)).toEqual({
      damageExcessAmount: null,
      damageExcessBoundBy: null,
    });
  });

  /**
   * **No currency comes out of here**, deliberately: the caller already writes
   * `currency` from the total, and a second expression of it is how a row comes
   * to hold a price in one currency and a hold in another.
   */
  it('never returns a currency', () => {
    expect(
      Object.keys(
        damageExcessColumns({
          amount: { amount: 7_500, currency: 'GBP' },
          boundBy: 'floor',
        }),
      ).sort(),
    ).toEqual(['damageExcessAmount', 'damageExcessBoundBy']);
  });
});
