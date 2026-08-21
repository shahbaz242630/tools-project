import { describe, expect, it } from 'vitest';
import { Money } from '@platform/core';
import type { DamageSecurityPolicy } from '@platform/contracts';
import { appliedExcessFor, appliedExcessOrNone } from './damage-excess.js';

/**
 * BRD §8.7.2's excess model, and ADR 0052's reading of where the ceiling binds.
 *
 * The numbers here are invented for the test and are not configuration — no
 * category in this repository carries them, and none should be copied from here.
 */

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

/** Floor £75, 15%, ceiling £500 — a plausible tool-hire band, for arithmetic. */
const band: DamageSecurityPolicy = {
  excessFloor: gbp(7_500),
  excessPercentageBasisPoints: 1_500,
  recoveryCeiling: gbp(50_000),
};

describe('appliedExcessFor', () => {
  it('takes the floor where the percentage falls below it', () => {
    // 15% of £40 is £6, which is what §8.7.2's floor exists to suppress.
    const excess = appliedExcessFor(band, Money.money(4_000, 'GBP'));

    expect(excess.amount).toEqual(Money.money(7_500, 'GBP'));
    expect(excess.boundBy).toBe('floor');
  });

  it('takes the percentage where it rises above the floor', () => {
    // 15% of £900 is £135.
    const excess = appliedExcessFor(band, Money.money(90_000, 'GBP'));

    expect(excess.amount).toEqual(Money.money(13_500, 'GBP'));
    expect(excess.boundBy).toBe('percentage');
  });

  it('reports the floor rather than the percentage when the two are exactly equal', () => {
    // 15% of £500 is exactly £75.
    const excess = appliedExcessFor(band, Money.money(50_000, 'GBP'));

    expect(excess.amount).toEqual(Money.money(7_500, 'GBP'));
    /*
     * Arbitrary in arithmetic, deliberate in what it says: at a tie the floor is
     * the value that would still hold if the listing were repriced, so it is the
     * honest explanation of a figure that will not move.
     */
    expect(excess.boundBy).toBe('floor');
  });

  /**
   * ADR 0052's decision. Not §8.7.2's literal words — the one to read before
   * "simplifying" this back to a plain `max`.
   */
  it('caps the applied excess at the recovery ceiling', () => {
    // 15% of £4,000 is £600, above the £500 ceiling.
    const excess = appliedExcessFor(band, Money.money(400_000, 'GBP'));

    expect(excess.amount).toEqual(Money.money(50_000, 'GBP'));
    expect(excess.boundBy).toBe('ceiling');
  });

  it('names the ceiling, not the percentage, when the ceiling decided it', () => {
    /*
     * The losing comparison would say "percentage" — it beat the floor. What
     * decided the answer was the cap, and `boundBy` describes the answer.
     */
    expect(appliedExcessFor(band, Money.money(400_000, 'GBP')).boundBy).toBe('ceiling');
  });

  it('leaves an excess exactly at the ceiling uncapped', () => {
    /*
     * The boundary itself. 15% of £3,333.34 is £500.001, which rounds to £500 —
     * equal to the ceiling, so `greaterThan` is false and the percentage stands.
     * A `>=` here would report every exactly-at-the-ceiling band as capped.
     */
    const excess = appliedExcessFor(band, Money.money(333_334, 'GBP'));

    expect(excess.amount).toEqual(Money.money(50_000, 'GBP'));
    expect(excess.boundBy).toBe('percentage');
  });

  it('rounds the percentage half-up to a whole penny, once', () => {
    // 15% of £33.33 is 499.95p.
    const excess = appliedExcessFor(
      { ...band, excessFloor: gbp(0) },
      Money.money(3_333, 'GBP'),
    );

    expect(excess.amount).toEqual(Money.money(500, 'GBP'));
  });

  it('sizes the excess entirely from the percentage when the floor is zero', () => {
    const noFloor: DamageSecurityPolicy = { ...band, excessFloor: gbp(0) };

    const excess = appliedExcessFor(noFloor, Money.money(20_000, 'GBP'));

    expect(excess.amount).toEqual(Money.money(3_000, 'GBP'));
    expect(excess.boundBy).toBe('percentage');
  });

  it('sizes the excess entirely from the floor when the percentage is zero', () => {
    /*
     * A category whose items are all worth about the same — §8.7.2 permits it,
     * and the result must not depend on replacement value at all.
     */
    const flat: DamageSecurityPolicy = { ...band, excessPercentageBasisPoints: 0 };

    expect(appliedExcessFor(flat, Money.money(4_000, 'GBP')).amount).toEqual(
      Money.money(7_500, 'GBP'),
    );
    expect(appliedExcessFor(flat, Money.money(400_000, 'GBP')).amount).toEqual(
      Money.money(7_500, 'GBP'),
    );
  });

  it('never exceeds the ceiling, whatever the listing is worth', () => {
    /*
     * The property §8.7.1 makes matter: the hold is a hard ceiling on card
     * recovery, so the figure it is sized from may never exceed what we have
     * published as recoverable. Swept rather than sampled, because a single
     * example would pass under a `max`-only implementation too.
     */
    for (let value = 100; value <= 10_000_000; value += 37_501) {
      const excess = appliedExcessFor(band, Money.money(value, 'GBP'));

      expect(excess.amount.amount).toBeLessThanOrEqual(band.recoveryCeiling.amount);
    }
  });

  it('never falls below the floor until the ceiling forces it', () => {
    /*
     * The other half of the same sweep. The floor is what a renter "always
     * bears", so the only thing entitled to reduce it is the ceiling — and a
     * band whose floor is at or below its ceiling (which the contract and the
     * CHECK both require) can never be forced below it.
     */
    for (let value = 100; value <= 10_000_000; value += 37_501) {
      const excess = appliedExcessFor(band, Money.money(value, 'GBP'));

      expect(excess.amount.amount).toBeGreaterThanOrEqual(band.excessFloor.amount);
    }
  });

  it('rises monotonically with replacement value', () => {
    /*
     * A more valuable item may never carry a smaller excess. `max` and `min` are
     * both monotonic so this is structural rather than lucky — which is exactly
     * why it is worth pinning: it is the property a "simplification" would break
     * silently, the same argument ADR 0047 makes about the quote engine.
     */
    let previous = -1;

    for (let value = 100; value <= 1_000_000; value += 4_999) {
      const excess = appliedExcessFor(band, Money.money(value, 'GBP'));

      expect(excess.amount.amount).toBeGreaterThanOrEqual(previous);
      previous = excess.amount.amount;
    }
  });

  it('holds the floor at the smallest replacement value a listing may carry', () => {
    // `MIN_REPLACEMENT_VALUE_MINOR` is £1. 15% of it is 15p.
    const excess = appliedExcessFor(band, Money.money(100, 'GBP'));

    expect(excess.amount).toEqual(Money.money(7_500, 'GBP'));
    expect(excess.boundBy).toBe('floor');
  });

  it('caps at the ceiling for the largest replacement value a listing may carry', () => {
    // `MAX_REPLACEMENT_VALUE_MINOR` is £100,000. 15% is £15,000.
    const excess = appliedExcessFor(band, Money.money(10_000_000, 'GBP'));

    expect(excess.amount).toEqual(Money.money(50_000, 'GBP'));
    expect(excess.boundBy).toBe('ceiling');
  });

  it('gives a zero excess only where the whole band is zero-sized', () => {
    /*
     * A floor of zero and a percentage of zero is a band that holds nothing —
     * expressible, and different from having no band. 5.5c has to tell the two
     * apart, so this pins that the arithmetic does not collapse them.
     */
    const empty: DamageSecurityPolicy = {
      excessFloor: gbp(0),
      excessPercentageBasisPoints: 0,
      recoveryCeiling: gbp(50_000),
    };

    const excess = appliedExcessFor(empty, Money.money(90_000, 'GBP'));

    expect(Money.isZero(excess.amount)).toBe(true);
    expect(excess.boundBy).toBe('floor');
  });
});

describe('appliedExcessOrNone', () => {
  it('returns null for a category that requires no damage security', () => {
    /*
     * §8.7.2's "configured to require no security". The absence travels rather
     * than collapsing to a zero amount: "we hold nothing" and "there is no band"
     * produce the same hold and are different facts, and 5.5c must tell a
     * deliberately unsecured handover from a failed one.
     */
    expect(appliedExcessOrNone(null, Money.money(90_000, 'GBP'))).toBeNull();
  });

  it('computes the excess for a category that has a band', () => {
    expect(appliedExcessOrNone(band, Money.money(90_000, 'GBP'))).toEqual({
      amount: Money.money(13_500, 'GBP'),
      boundBy: 'percentage',
    });
  });
});
