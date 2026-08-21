import { describe, expect, it } from 'vitest';
import { Money } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { UK_STRIPE_COST_MODEL, applyRate, assumptionsIn } from './cost-model.js';
import type { CostModel } from './cost-model.js';
import {
  UnitEconomicsError,
  breakEvenOwnerActivity,
  marginAcrossOwnerActivity,
  unitEconomicsOf,
} from './unit-economics.js';

/**
 * What the platform earns on a booking (§3.4.1, §3.4.3, slice 5.3a).
 *
 * **The arithmetic is the easy half; the hard half is that the model covers
 * §3.4.1 at all.** A cost component that is specified and quietly not summed
 * produces a model that is confidently wrong in the profitable direction, and
 * nothing about the output would look off. So the first test walks the breakdown
 * against the total, and it fails when a component is added without being
 * counted.
 */

const gbp = (pence: number) => Money.money(pence, 'GBP');

/** `outdoor-gardening` v2, as configured in the real database on 21 Aug 2026. */
const GARDENING: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_600,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: gbp(1_000),
  minimumPlatformFee: gbp(100),
};

const NO_DAMAGE_SECURITY = gbp(0);

const at = (grossPence: number, bookingsPerMonth: number, policy = GARDENING) =>
  unitEconomicsOf(
    {
      grossBookingValue: gbp(grossPence),
      damageSecurityCaptured: NO_DAMAGE_SECURITY,
      bookingsPerActiveOwnerPerMonth: bookingsPerMonth,
    },
    policy,
    UK_STRIPE_COST_MODEL,
  );

describe('the cost breakdown covers §3.4.1', () => {
  /**
   * **The guard against a specified cost quietly going uncounted.** Summing the
   * breakdown independently and comparing is what makes adding a field to
   * `CostBreakdown` without adding it to the total a test failure rather than a
   * silent understatement of what a booking costs.
   */
  it('totals exactly the components it lists, with nothing left out', () => {
    const economics = at(5_000, 4);
    const summed = Money.sum(Object.values(economics.costs), 'GBP');

    expect(economics.totalCost).toEqual(summed);
  });

  it('names one component for every cost §3.4.1 requires', () => {
    // Read against the specification rather than against the implementation:
    // these are §3.4.1's clauses in its own order.
    expect(Object.keys(at(5_000, 4).costs).sort()).toEqual(
      [
        'cardProcessing',
        'damageSecurityProcessing',
        'payout',
        'connectedAccount',
        'extendedAuthorisation',
        'identityVerification',
        'sms',
        'refunds',
        'chargebacks',
        'support',
      ].sort(),
    );
  });

  it('keeps every amount in whole pence', () => {
    // ADR 0002. A float here would survive every other assertion in this file.
    const economics = at(3_333, 3);

    for (const amount of [
      ...Object.values(economics.costs),
      economics.totalCost,
      economics.platformRevenue,
      economics.contributionMargin,
    ]) {
      expect(Number.isInteger(amount.amount)).toBe(true);
    }
  });
});

describe('revenue', () => {
  it('is the renter fee plus the owner commission, and nothing else', () => {
    const economics = at(5_000, 4);

    expect(economics.platformRevenue).toEqual(
      Money.add(economics.renterFee, economics.ownerCommission),
    );
  });

  it('leaves the owner their charge less commission', () => {
    const economics = at(5_000, 4);

    // 16% of £50.00 is £8.00.
    expect(economics.ownerCommission).toEqual(gbp(800));
    expect(economics.ownerProceeds).toEqual(gbp(4_200));
  });

  it('charges the renter the hire plus their fee', () => {
    const economics = at(5_000, 4);

    // 8% of £50.00 is £4.00, so the card is charged £54.00.
    expect(economics.renterFee).toEqual(gbp(400));
    expect(economics.renterPays).toEqual(gbp(5_400));
  });

  /**
   * **The fee comes from `renterFeeOn` rather than a second implementation.** If
   * this file recomputed it, the model could report a margin on a price no renter
   * is ever shown — which is the one way a unit-economics model can be both
   * internally consistent and useless.
   */
  it('reports the §3.4.2 floor binding at the minimum booking total', () => {
    const economics = at(1_000, 1);

    // 8% of £10.00 is 80p, below the £1.00 floor, so the floor binds.
    expect(economics.minimumFeeApplied).toBe(true);
    expect(economics.renterFee).toEqual(gbp(100));
  });
});

describe('costs', () => {
  it('charges card processing on what the renter actually pays', () => {
    const economics = at(5_000, 4);

    // 1.5% of £54.00 plus 20p.
    expect(economics.costs.cardProcessing).toEqual(
      applyRate(UK_STRIPE_COST_MODEL.cardProcessing.value, gbp(5_400)),
    );
  });

  it('charges the payout fee on what the owner receives, not on the hire', () => {
    const economics = at(5_000, 4);

    expect(economics.costs.payout).toEqual(
      applyRate(UK_STRIPE_COST_MODEL.payout.value, gbp(4_200)),
    );
  });

  /**
   * **The single most consequential line in the model.** Stripe charges £2 per
   * active connected account per *month*, so the cost a booking carries depends
   * entirely on how often its owner lets — and nobody has measured that.
   */
  it('amortises the £2 connected-account fee across the owner’s month', () => {
    expect(at(5_000, 1).costs.connectedAccount).toEqual(gbp(200));
    expect(at(5_000, 2).costs.connectedAccount).toEqual(gbp(100));
    expect(at(5_000, 8).costs.connectedAccount).toEqual(gbp(25));
  });

  /**
   * **Nothing captured, nothing charged.** Most holds expire unused (§8.7.2), and
   * charging the fixed 20p against every booking would invent a cost on the
   * majority that end well.
   */
  it('charges nothing to process a damage security that was never captured', () => {
    expect(at(5_000, 4).costs.damageSecurityProcessing).toEqual(gbp(0));
  });

  it('charges processing on a damage security that was captured', () => {
    const economics = unitEconomicsOf(
      {
        grossBookingValue: gbp(5_000),
        damageSecurityCaptured: gbp(10_000),
        bookingsPerActiveOwnerPerMonth: 4,
      },
      GARDENING,
      UK_STRIPE_COST_MODEL,
    );

    expect(economics.costs.damageSecurityProcessing).toEqual(
      applyRate(UK_STRIPE_COST_MODEL.damageSecurityProcessing.value, gbp(10_000)),
    );
  });

  /**
   * **Stripe does not return the fee on a refunded transaction** — their published
   * pricing says so explicitly — so a refund costs us what we already paid to
   * take the money, and that expected cost belongs on every booking rather than
   * on the refunded ones only.
   */
  it('carries the retained processing fee as an expected refund cost', () => {
    const economics = at(5_000, 4);

    expect(economics.costs.refunds).toEqual(
      Money.multiply(
        economics.costs.cardProcessing,
        UK_STRIPE_COST_MODEL.refundRate.value,
      ),
    );
    expect(Money.isPositive(economics.costs.refunds)).toBe(true);
  });

  it('carries the dispute fee and the lost processing as an expected chargeback cost', () => {
    const economics = at(5_000, 4);

    expect(economics.costs.chargebacks).toEqual(
      Money.multiply(
        Money.add(
          UK_STRIPE_COST_MODEL.disputeFee.value,
          economics.costs.cardProcessing,
        ),
        UK_STRIPE_COST_MODEL.chargebackRate.value,
      ),
    );
  });
});

describe('an owner completing a booking was active that month', () => {
  it('refuses fewer than one booking a month rather than clamping', () => {
    // Clamping would understate the amortised account fee without looking wrong.
    expect(() => at(5_000, 0)).toThrow(UnitEconomicsError);
    expect(() => at(5_000, 0.5)).toThrow(UnitEconomicsError);
  });
});

describe('margin across owner activity', () => {
  /**
   * **Structural rather than tested-and-hoped**, the way ADR 0047 argues for the
   * quote engine's monotonicity: the connected-account fee is the only cost that
   * moves with owner activity and it can only fall, so margin can only rise. That
   * is what makes a break-even threshold meaningful — if margin could fall again,
   * a single crossing point would be a lie.
   */
  it('never falls as the owner gets busier', () => {
    const curve = marginAcrossOwnerActivity(
      { grossBookingValue: gbp(1_000), damageSecurityCaptured: NO_DAMAGE_SECURITY },
      GARDENING,
      UK_STRIPE_COST_MODEL,
      [1, 2, 3, 4, 6, 8, 12, 20],
    );

    for (let i = 1; i < curve.length; i += 1) {
      const previous = curve[i - 1]?.economics.contributionMargin;
      const current = curve[i]?.economics.contributionMargin;
      if (previous === undefined || current === undefined)
        throw new Error('short curve');

      expect(Money.compare(current, previous)).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports the first activity level that pays for itself', () => {
    const breakEven = breakEvenOwnerActivity(
      { grossBookingValue: gbp(1_000), damageSecurityCaptured: NO_DAMAGE_SECURITY },
      GARDENING,
      UK_STRIPE_COST_MODEL,
    );

    expect(breakEven).not.toBeNull();
    if (breakEven === null) throw new Error('unreachable');

    expect(Money.isNegative(at(1_000, breakEven).contributionMargin)).toBe(false);
    expect(Money.isNegative(at(1_000, breakEven - 1).contributionMargin)).toBe(true);
  });

  /**
   * **A booking can be unprofitable at every activity level**, and the model has
   * to be able to say so rather than returning a large number that looks like an
   * answer. Below roughly 50p of platform revenue the fixed costs alone — 20p
   * card, 10p payout, 8p SMS, 15p support — exceed it however busy the owner is.
   */
  it('answers null when no amount of owner activity would ever pay for it', () => {
    const noFloors: CategoryFeePolicy = {
      ownerCommissionBasisPoints: 1_800,
      renterFeeBasisPoints: 1_000,
      minimumBookingTotal: gbp(0),
      minimumPlatformFee: gbp(0),
    };

    expect(
      breakEvenOwnerActivity(
        { grossBookingValue: gbp(100), damageSecurityCaptured: NO_DAMAGE_SECURITY },
        noFloors,
        UK_STRIPE_COST_MODEL,
      ),
    ).toBeNull();
  });
});

/**
 * **The finding this slice exists to produce, pinned so a fee change is visible.**
 *
 * These are not aspirations — they are what the real configuration and Stripe's
 * published rates produce on 21 August 2026. They are asserted so that changing a
 * fee percentage, a floor, or a cost assumption shows up in review as a changed
 * expectation rather than as a quietly different worked example.
 *
 * **§3.4.3 forbids enabling a category for public booking when contribution
 * margin at the minimum booking total is negative**, so the first of these is a
 * live finding against the launch category, not a curiosity.
 */
describe('the launch category as configured today', () => {
  it('loses money on a booking at its £10 floor from a once-a-month owner', () => {
    const economics = at(1_000, 1);

    expect(economics.platformRevenue).toEqual(gbp(260));
    expect(economics.contributionMargin).toEqual(gbp(-23));
    expect(Money.isNegative(economics.contributionMargin)).toBe(true);
  });

  it('needs two bookings a month from an owner to pay for itself at the floor', () => {
    expect(
      breakEvenOwnerActivity(
        { grossBookingValue: gbp(1_000), damageSecurityCaptured: NO_DAMAGE_SECURITY },
        GARDENING,
        UK_STRIPE_COST_MODEL,
      ),
    ).toBe(2);
  });

  it('is comfortably profitable at an ordinary booking value', () => {
    // The problem is the floor, not the fee percentages.
    expect(Money.isPositive(at(2_500, 1).contributionMargin)).toBe(true);
    expect(Money.isPositive(at(5_000, 1).contributionMargin)).toBe(true);
  });
});

describe('the cost model itself', () => {
  /**
   * **Every number is either sourced or declared an assumption.** A rate with
   * neither is a number somebody invented, and this is a financial model.
   */
  it('gives every component a provenance', () => {
    for (const [field, component] of Object.entries(UK_STRIPE_COST_MODEL)) {
      if (field === 'currency') continue;
      if (typeof component !== 'object' || component === null) continue;

      expect(component).toHaveProperty('provenance');
      const { provenance } = component as { provenance: { kind: string } };
      expect(['published', 'assumption']).toContain(provenance.kind);
    }
  });

  it('dates every published rate, because rates move', () => {
    for (const [field, component] of Object.entries(UK_STRIPE_COST_MODEL)) {
      if (field === 'currency') continue;
      if (typeof component !== 'object' || component === null) continue;

      const { provenance } = component as {
        provenance: { kind: string; readOn?: string; source?: string };
      };
      if (provenance.kind !== 'published') continue;

      expect(provenance.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(provenance.source).toMatch(/^https:\/\//);
    }
  });

  /**
   * **The assumptions are enumerable so the worked example can print them all.**
   * §3.4.3 asks for a documented example; a document that shows costs without
   * showing which of them were guessed is a document that overstates its own
   * authority.
   */
  it('can list its assumptions for the worked example to publish', () => {
    const assumptions = assumptionsIn(UK_STRIPE_COST_MODEL);

    expect(assumptions.length).toBeGreaterThan(0);
    for (const assumption of assumptions) {
      expect(assumption.basis.length).toBeGreaterThan(0);
    }
    expect(assumptions.map((a) => a.field)).toContain('supportPerBooking');
  });
});

/** A model with everything zeroed, to prove nothing is hard-coded. */
describe('a different cost model', () => {
  it('changes the answer, so nothing here is baked in', () => {
    const free: CostModel = {
      ...UK_STRIPE_COST_MODEL,
      cardProcessing: {
        value: { percent: 0, fixed: gbp(0) },
        provenance: { kind: 'assumption', basis: 'test', owner: 'product-owner' },
      },
      payout: {
        value: { percent: 0, fixed: gbp(0) },
        provenance: { kind: 'assumption', basis: 'test', owner: 'product-owner' },
      },
      connectedAccountMonthly: {
        value: gbp(0),
        provenance: { kind: 'assumption', basis: 'test', owner: 'product-owner' },
      },
      smsPerMessage: {
        value: gbp(0),
        provenance: { kind: 'assumption', basis: 'test', owner: 'product-owner' },
      },
      supportPerBooking: {
        value: gbp(0),
        provenance: { kind: 'assumption', basis: 'test', owner: 'product-owner' },
      },
      disputeFee: {
        value: gbp(0),
        provenance: { kind: 'assumption', basis: 'test', owner: 'product-owner' },
      },
    };

    const economics = unitEconomicsOf(
      {
        grossBookingValue: gbp(1_000),
        damageSecurityCaptured: NO_DAMAGE_SECURITY,
        bookingsPerActiveOwnerPerMonth: 1,
      },
      GARDENING,
      free,
    );

    expect(economics.totalCost).toEqual(gbp(0));
    expect(economics.contributionMargin).toEqual(economics.platformRevenue);
  });
});
