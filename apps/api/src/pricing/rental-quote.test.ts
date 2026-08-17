import { describe, expect, it } from 'vitest';
import { Money, Time } from '@platform/core';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import {
  chooseCheapestUnits,
  describeBelowMinimumBooking,
  priceRental,
  refuseBelowMinimumBooking,
} from './rental-quote.js';

/**
 * The pricing rule from 16 August 2026, and the two properties it was chosen
 * for. See ADR 0047 and `rental-quote.ts`.
 */

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

/** £10 a day, £50 a week — Fat Llama's own worked example. */
const tenAndFifty: ListingRateCard = {
  daily: gbp(1_000),
  weekend: null,
  weekly: gbp(5_000),
};

const dailyOnly: ListingRateCard = { daily: gbp(1_000), weekend: null, weekly: null };

const freePolicy: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 0,
  renterFeeBasisPoints: 0,
  minimumBookingTotal: gbp(0),
  minimumPlatformFee: gbp(0),
};

/** The fixture's `outdoor-gardening`: 16% owner, 8% renter, £10 / £1 floors. */
const gardeningPolicy: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_600,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: gbp(1_000),
  minimumPlatformFee: gbp(100),
};

/** A Monday, so the weekend rate is not in play unless a test asks for it. */
const MONDAY = Time.weekdayOf('2026-08-17');
const FRIDAY = Time.weekdayOf('2026-08-21');

function chargeFor(days: number, rates: ListingRateCard, weekday = MONDAY): number {
  const units = chooseCheapestUnits(days, weekday, rates);
  if (units === null) throw new Error('expected a price');
  return units.itemCharge.amount;
}

describe('chooseCheapestUnits', () => {
  it('charges by the day when there is no other rate', () => {
    expect(chargeFor(3, dailyOnly)).toBe(3_000);
  });

  it('charges whole weeks at the weekly rate and the remainder daily', () => {
    // Ten days: one week plus three days. The rule in the sentence a renter is
    // told, and the case the decision was written about.
    expect(chargeFor(10, tenAndFifty)).toBe(5_000 + 3_000);

    const units = chooseCheapestUnits(10, MONDAY, tenAndFifty);
    expect(units?.lineItems).toEqual([
      { unit: 'week', count: 1, unitPrice: gbp(5_000), subtotal: gbp(5_000) },
      { unit: 'day', count: 3, unitPrice: gbp(1_000), subtotal: gbp(3_000) },
    ]);
  });

  it('buys the next whole week when that is cheaper than the remaining days', () => {
    // Six days is £60 by the day and £50 as a week. It buys the week — which is
    // the whole reason this is coverage rather than decomposition, and the
    // reason six days never costs more than seven.
    expect(chargeFor(6, tenAndFifty)).toBe(5_000);
    expect(chooseCheapestUnits(6, MONDAY, tenAndFifty)?.lineItems).toEqual([
      { unit: 'week', count: 1, unitPrice: gbp(5_000), subtotal: gbp(5_000) },
    ]);
  });

  it('does not buy a week when the days alone come to less', () => {
    // Four days at £10 is £40, under the £50 week. Nobody is charged for
    // coverage they did not need.
    expect(chargeFor(4, tenAndFifty)).toBe(4_000);
  });

  it('breaks a tie towards the larger unit', () => {
    // Seven days at £10 and one week at £70 are the same money. "1 week" is the
    // line an owner meant and a renter understands.
    const sevenAndSeventy: ListingRateCard = {
      daily: gbp(1_000),
      weekend: null,
      weekly: gbp(7_000),
    };
    expect(chooseCheapestUnits(7, MONDAY, sevenAndSeventy)?.lineItems).toEqual([
      { unit: 'week', count: 1, unitPrice: gbp(7_000), subtotal: gbp(7_000) },
    ]);
  });

  it('uses several weeks for a long hire', () => {
    // 88 days — the statutory ceiling (§8.5.3) — is twelve weeks and four days.
    // A thirteenth week would cover the remainder but costs £50 where four days
    // cost £40, so the remainder stays daily.
    expect(chargeFor(88, tenAndFifty)).toBe(12 * 5_000 + 4 * 1_000);
  });

  describe('the weekend rate', () => {
    const withWeekend: ListingRateCard = {
      daily: gbp(1_000),
      weekend: gbp(1_500),
      weekly: gbp(5_000),
    };

    it('applies to a hire that starts on a Friday', () => {
      // Friday to Sunday: £15 as a weekend against £30 by the day.
      expect(chargeFor(3, withWeekend, FRIDAY)).toBe(1_500);
      expect(chooseCheapestUnits(3, FRIDAY, withWeekend)?.lineItems).toEqual([
        { unit: 'weekend', count: 1, unitPrice: gbp(1_500), subtotal: gbp(1_500) },
      ]);
    });

    it('does not apply to a hire that starts on any other day', () => {
      // The same three days from a Monday are three days. The rate is named
      // after an occasion, not a quantity — see `toAvailableRates`.
      expect(chargeFor(3, withWeekend, MONDAY)).toBe(3_000);
    });

    it('covers a shorter hire that starts on a Friday when it is cheaper', () => {
      // A single Friday: the weekend covers it and costs £15 against £10 by the
      // day, so the day wins. The point is that both were considered.
      expect(chargeFor(1, withWeekend, FRIDAY)).toBe(1_000);

      const cheapWeekend: ListingRateCard = {
        daily: gbp(1_000),
        weekend: gbp(800),
        weekly: null,
      };
      // Now the weekend is cheaper than one day of it, so that is what a Friday
      // hire is charged — "the cheapest way from the owner's own prices",
      // applied without exception.
      expect(chargeFor(1, cheapWeekend, FRIDAY)).toBe(800);
    });

    it('is used at most once in a hire', () => {
      // Seventeen days from a Friday contains two Friday-to-Sunday weekends. A
      // rate called "weekend" prices one of them; charging both while the
      // intervening week goes unpriced describes nothing an owner chose.
      const units = chooseCheapestUnits(17, FRIDAY, withWeekend);
      const weekend = units?.lineItems.find((item) => item.unit === 'weekend');
      expect(weekend?.count ?? 0).toBeLessThanOrEqual(1);
    });

    it('combines with weeks when that is the cheapest cover', () => {
      // Ten days from a Friday: a weekend plus a week covers it for £65, where a
      // week plus three days is £80.
      expect(chargeFor(10, withWeekend, FRIDAY)).toBe(1_500 + 5_000);
    });
  });

  describe('what cannot be priced', () => {
    it('refuses a listing with no daily rate', () => {
      expect(
        chooseCheapestUnits(3, MONDAY, { daily: null, weekend: null, weekly: null }),
      ).toBe(null);
    });

    it('refuses a hire of less than a day', () => {
      // `refusePeriod` has already refused an inverted period; this is the
      // second wall, and it refuses rather than pricing nothing at zero.
      expect(chooseCheapestUnits(0, MONDAY, tenAndFifty)).toBe(null);
      expect(chooseCheapestUnits(-1, MONDAY, tenAndFifty)).toBe(null);
      expect(chooseCheapestUnits(1.5, MONDAY, tenAndFifty)).toBe(null);
    });
  });
});

/**
 * The two properties the rule was chosen for. They are structural — see the
 * reasoning in `rental-quote.ts` — and these tests exist to catch the file being
 * rewritten into the decomposition that breaks them.
 *
 * Exercised across a spread of rate shapes rather than one, including several
 * where the weekly rate is absurdly generous, because that is where a
 * decomposition rule fails.
 */
describe('the properties', () => {
  const shapes: readonly (readonly [string, ListingRateCard])[] = [
    ['daily only', dailyOnly],
    ['£10 day, £50 week', tenAndFifty],
    [
      'generous week — £10 day, £15 week',
      { daily: gbp(1_000), weekend: null, weekly: gbp(1_500) },
    ],
    [
      'week dearer than seven days',
      { daily: gbp(1_000), weekend: null, weekly: gbp(9_000) },
    ],
    [
      'weekend and week',
      { daily: gbp(1_000), weekend: gbp(1_500), weekly: gbp(5_000) },
    ],
    ['cheap weekend', { daily: gbp(2_000), weekend: gbp(500), weekly: gbp(9_900) }],
    ['odd pennies', { daily: gbp(1_333), weekend: gbp(2_777), weekly: gbp(7_101) }],
  ];

  const weekdays = [1, 5, 7] as const;

  for (const [name, rates] of shapes) {
    for (const weekday of weekdays) {
      it(`never charges more than the naive daily total — ${name}, weekday ${String(weekday)}`, () => {
        const daily = rates.daily?.amount ?? 0;

        for (let days = 1; days <= 88; days += 1) {
          expect(chargeFor(days, rates, weekday)).toBeLessThanOrEqual(days * daily);
        }
      });

      it(`never gets cheaper as the hire lengthens — ${name}, weekday ${String(weekday)}`, () => {
        // The property whose absence produces a support enquiry nobody can
        // answer: six days costing more than seven.
        let previous = 0;

        for (let days = 1; days <= 88; days += 1) {
          const charge = chargeFor(days, rates, weekday);
          expect(charge).toBeGreaterThanOrEqual(previous);
          previous = charge;
        }
      });
    }
  }

  it('is what the decomposition rule would get wrong', () => {
    // The counter-example in one assertion, so the reason for the whole design
    // is visible in the suite: weeks-plus-remainder charges £60 for six days
    // and £50 for seven.
    expect(chargeFor(6, tenAndFifty)).toBeLessThanOrEqual(chargeFor(7, tenAndFifty));
    expect(chargeFor(6, tenAndFifty)).toBe(5_000);
  });
});

describe('priceRental', () => {
  it('adds the renter fee to the item charge', () => {
    const priced = priceRental(3, MONDAY, dailyOnly, gardeningPolicy);

    // £30 for three days, 8% is £2.40, so £32.40 inclusive.
    expect(priced?.itemCharge).toEqual(gbp(3_000));
    expect(priced?.renterFee).toEqual(gbp(240));
    expect(priced?.total).toEqual(gbp(3_240));
    expect(priced?.minimumFeeApplied).toBe(false);
  });

  it('applies the fee floor once for the whole period, not once a day', () => {
    // A £1 day at 8% is 8p, under the £1 floor. The floor binds — once.
    const cheap: ListingRateCard = { daily: gbp(100), weekend: null, weekly: null };
    const priced = priceRental(14, MONDAY, cheap, gardeningPolicy);

    // £14 of hire, 8% is £1.12, which is above the £1 floor — so on a fortnight
    // the percentage wins even though it would not on one day.
    expect(priced?.itemCharge).toEqual(gbp(1_400));
    expect(priced?.renterFee).toEqual(gbp(112));
    expect(priced?.minimumFeeApplied).toBe(false);

    const oneDay = priceRental(1, MONDAY, cheap, gardeningPolicy);
    expect(oneDay?.renterFee).toEqual(gbp(100));
    expect(oneDay?.minimumFeeApplied).toBe(true);
  });

  it('charges no fee where the category takes none', () => {
    const priced = priceRental(2, MONDAY, dailyOnly, freePolicy);

    expect(priced?.renterFee).toEqual(gbp(0));
    expect(priced?.total).toEqual(gbp(2_000));
  });

  it('cannot price a listing with no rates', () => {
    expect(
      priceRental(
        2,
        MONDAY,
        { daily: null, weekend: null, weekly: null },
        gardeningPolicy,
      ),
    ).toBe(null);
  });

  it('keeps the total equal to the sum of its parts', () => {
    // §6.1: rounding happens once. A total that is not its own breakdown is the
    // failure this guards.
    for (let days = 1; days <= 30; days += 1) {
      const priced = priceRental(days, FRIDAY, tenAndFifty, gardeningPolicy);
      if (priced === null) throw new Error('expected a price');

      const lineTotal = priced.lineItems.reduce(
        (sum, item) => sum + item.subtotal.amount,
        0,
      );
      expect(priced.itemCharge.amount).toBe(lineTotal);
      expect(priced.total.amount).toBe(
        priced.itemCharge.amount + priced.renterFee.amount,
      );
    }
  });
});

describe('refuseBelowMinimumBooking', () => {
  it('refuses a total under the category minimum', () => {
    const refusal = refuseBelowMinimumBooking(Money.money(500, 'GBP'), gardeningPolicy);

    expect(refusal).toEqual({ total: gbp(500), minimum: gbp(1_000) });
  });

  it('allows a total exactly at the minimum', () => {
    // The floor is a minimum, not a threshold to exceed.
    expect(refuseBelowMinimumBooking(Money.money(1_000, 'GBP'), gardeningPolicy)).toBe(
      null,
    );
  });

  it('allows anything where no minimum is configured', () => {
    expect(refuseBelowMinimumBooking(Money.money(1, 'GBP'), freePolicy)).toBe(null);
  });

  it('names both numbers and says what to do', () => {
    const refusal = refuseBelowMinimumBooking(Money.money(500, 'GBP'), gardeningPolicy);
    if (refusal === null) throw new Error('expected a refusal');

    const sentence = describeBelowMinimumBooking(refusal);

    expect(sentence).toContain('£5.00');
    expect(sentence).toContain('£10.00');
    expect(sentence).toContain('longer');
  });
});
