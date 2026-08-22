import { describe, expect, it } from 'vitest';
import { asDamageSecurity } from './damage-security-columns.js';

/**
 * The five nullable columns, on the way back out (§8.7.2, ADR 0052).
 *
 * **These are the tests the database cannot write.** `damage_security_is_complete`
 * makes a partial band unstorable and `excess_band_currencies_agree` makes a
 * mismatched pair unstorable, so `prisma-category-store.db.test.ts` can prove the
 * CHECKs refuse them — and can never reach the assertions in this mapper, which
 * exist for the row a future migration writes around them.
 *
 * Extracted from `prisma-category-store.ts` in slice 5.5b-i when the listing
 * store became its second reader. It had no direct test while it was private to
 * one adapter; a rule with two callers should have one.
 */
describe('asDamageSecurity', () => {
  const band = {
    excessFloorAmount: 7_500,
    excessFloorCurrency: 'GBP',
    excessPercentageBasisPoints: 1_500,
    recoveryCeilingAmount: 50_000,
    recoveryCeilingCurrency: 'GBP',
  };

  it('reads the five columns as a band', () => {
    expect(asDamageSecurity(band, 'Category outdoor-gardening')).toEqual({
      excessFloor: { amount: 7_500, currency: 'GBP' },
      excessPercentageBasisPoints: 1_500,
      recoveryCeiling: { amount: 50_000, currency: 'GBP' },
    });
  });

  /**
   * **Five nulls are "requires no security", not "not configured"** — §8.7.2
   * permits the former and ADR 0052 expresses it by absence. Collapsing it to a
   * zero band would make a deliberately unsecured handover indistinguishable
   * from one whose hold is worthless.
   */
  it('reads five nulls as no security at all', () => {
    expect(
      asDamageSecurity(
        {
          excessFloorAmount: null,
          excessFloorCurrency: null,
          excessPercentageBasisPoints: null,
          recoveryCeilingAmount: null,
          recoveryCeilingCurrency: null,
        },
        'Category power-tools',
      ),
    ).toBeNull();
  });

  /**
   * **A zero floor is a real configuration and must not read as absence.** The
   * ceiling is the column that decides, because the CHECK requires it positive —
   * a mapper that keyed on the floor would report "no security" for a category
   * that had chosen to bear the whole percentage from the first penny.
   */
  it('keeps a band whose floor is zero', () => {
    const noFloor = { ...band, excessFloorAmount: 0 };

    expect(asDamageSecurity(noFloor, 'Category outdoor-gardening')).toEqual({
      excessFloor: { amount: 0, currency: 'GBP' },
      excessPercentageBasisPoints: 1_500,
      recoveryCeiling: { amount: 50_000, currency: 'GBP' },
    });
  });

  /**
   * **A partial band throws rather than defaulting**, and it names the subject.
   *
   * `damage_security_is_complete` makes this unreachable through the product, so
   * the case exists for a row written around the constraint — a future migration,
   * a manual fix, a restore from a database that predates the CHECK. Four `?? 0`
   * defaults would turn that into a silently wrong band, and a wrong band is an
   * amount held against somebody's card.
   */
  it.each([
    ['excessFloorAmount'],
    ['excessFloorCurrency'],
    ['excessPercentageBasisPoints'],
    ['recoveryCeilingCurrency'],
  ] as const)('refuses a band missing its %s', (column) => {
    expect(() =>
      asDamageSecurity({ ...band, [column]: null }, 'Category outdoor-gardening'),
    ).toThrow(/Category outdoor-gardening has a partial damage security band/);
  });

  /**
   * **A currency this build cannot do arithmetic in is refused, not coerced.**
   * `Money`'s operations reject a mismatched pair, so reading EUR as GBP would
   * surface deep inside a hold calculation with a message about currencies
   * rather than about a category — if it surfaced at all.
   */
  it.each([['excessFloorCurrency'], ['recoveryCeilingCurrency']] as const)(
    'refuses an unsupported %s',
    (column) => {
      expect(() =>
        asDamageSecurity({ ...band, [column]: 'EUR' }, 'Category outdoor-gardening'),
      ).toThrow(/EUR/);
    },
  );
});
