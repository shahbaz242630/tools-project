import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { AppliedExcess, DamageSecurityPolicy } from '@platform/contracts';
import { basisPointsToPercent } from '@platform/contracts';

/**
 * How much of a loss a renter bears on one booking — BRD §8.7.2's applied
 * excess, computed from the category's band and the listing's replacement value.
 *
 * **This is the number the damage-security hold is sized from** (5.5c), so it is
 * also the amount a renter is asked to authorise on a card. §8.7.1 makes that
 * consequential in a way an ordinary price is not: overcapture is unavailable to
 * this platform, so **the amount held is a hard ceiling on what can ever be
 * taken**. Too small and the excess is unrecoverable; too large and we are
 * holding money we have already published we will never claim.
 *
 * Sited in `pricing/` rather than beside the payment code that will use it,
 * because §6.1 puts the rounding rule in one module and this rounds — the same
 * argument that moved `renterFeeOn` here at its second caller.
 *
 * **`AppliedExcess` itself lives in `@platform/contracts` from slice 5.5b-i**,
 * where `DamageSecurityPolicy` already was. It was declared here while nothing
 * outside this application read it; a listing page renders it now, so the shape
 * crosses a wire and one definition has to serve both sides of it.
 */

/**
 * `min(ceiling, max(floor, percentage × replacement value))`.
 *
 * **The `max` is §8.7.2's own words; the `min` is ADR 0052's reading and the
 * part to understand before changing this.** §8.7.2 spells out that the applied
 * excess is "the greater of the floor and the percentage", and describes the
 * recovery ceiling only as capping "renter exposure" — in a different row of the
 * same table, without saying where it applies.
 *
 * It applies here. The applied excess *is* renter exposure, and it is what the
 * hold is sized from, so a ceiling that bound anywhere later would arrive after
 * we had already authorised more than we can recover. A category with a 20%
 * excess and a £500 ceiling would ask for £800 against a £4,000 plate
 * compactor, having published that £500 is the most it will ever take.
 *
 * The consequence, which is deliberate rather than a rounding of the rule: a
 * high-value listing in a category with a modest ceiling is **under-secured by
 * design**. §8.7.2 puts loss between the hold and the ceiling in the Phase 10
 * protection product's scope, and loss above the ceiling with the owner, who
 * must be told so before listing.
 */
export function appliedExcessFor(
  policy: DamageSecurityPolicy,
  replacementValue: MoneyValue,
): AppliedExcess {
  const floor = Money.money(policy.excessFloor.amount, policy.excessFloor.currency);
  const ceiling = Money.money(
    policy.recoveryCeiling.amount,
    policy.recoveryCeiling.currency,
  );

  /*
   * Rounded once, here, half-up to a whole penny — §6.1's single rounding rule,
   * applied through the same `percentageOf` the renter fee uses. Nothing
   * downstream may round again: a display helper formatting to two places, or a
   * hold amount recomputed from a percentage, is how the figure disclosed at
   * booking and the figure authorised at collection come to differ by a penny on
   * an amount somebody is disputing.
   */
  const percentage = Money.percentageOf(
    replacementValue,
    basisPointsToPercent(policy.excessPercentageBasisPoints),
  );

  const greaterOfTheTwo = Money.maxOf(floor, percentage);

  /*
   * **The ceiling is tested before the floor/percentage question is reported**,
   * so `boundBy` names what actually decided the number rather than what would
   * have decided it. A £900 percentage against a £500 ceiling is bound by the
   * ceiling; saying "percentage" there would be true about the losing comparison
   * and false about the answer.
   */
  if (Money.greaterThan(greaterOfTheTwo, ceiling)) {
    return { amount: ceiling, boundBy: 'ceiling' };
  }

  /*
   * Ties go to the floor, and the choice is arbitrary in arithmetic but not in
   * what it says. Where the two are equal the floor is the one that holds
   * whatever the item is worth, so it is the honest explanation of a figure that
   * would not move if the listing were repriced.
   */
  return {
    amount: greaterOfTheTwo,
    boundBy: Money.greaterThan(percentage, floor) ? 'percentage' : 'floor',
  };
}

/**
 * The same question for a category that may not have a band at all.
 *
 * **`null` in, `null` out.** §8.7.2 permits a category "configured to require no
 * security", so the absence has to travel rather than collapse to zero — a zero
 * applied excess would mean "we will hold nothing", which is the same outward
 * behaviour and a different fact. From 5.5c the distinction is what separates a
 * handover that is deliberately unsecured from one whose hold failed, and
 * §8.7.2 requires those be told apart.
 */
export function appliedExcessOrNone(
  policy: DamageSecurityPolicy | null,
  replacementValue: MoneyValue,
): AppliedExcess | null {
  return policy === null ? null : appliedExcessFor(policy, replacementValue);
}
