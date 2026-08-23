import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { UK_STRIPE_COST_MODEL } from './cost-model.js';
import type { CostModel } from './cost-model.js';
import { unitEconomicsOf } from './unit-economics.js';

/**
 * BRD §3.4.3's one binding clause, as a rule the product can enforce
 * (slice 5.3b).
 *
 * §3.4.3: *"A category may not be enabled for public booking if contribution
 * margin at the minimum booking total is negative."* **That is the only sentence
 * in §3.4.3 that forbids anything** — the three-point table beside it is a
 * documentation requirement — and until this slice **nothing in the product
 * enforced it**. `scripts/unit-economics.mjs` judged it and exited non-zero, which
 * is a report somebody has to remember to run, not a rule.
 *
 * **It lives in `pricing/` and not in `catalogue/` because the arithmetic does.**
 * Catalogue owns what a category *is*; §6.1 puts money and rounding here, and a
 * copy of this judgement beside the admin form would be a second implementation
 * of a legal threshold. The report script reads this same function through
 * `dist`, which is `measure-search`'s rule: what is checked is what ships.
 */

/**
 * The booking value used when a category sets no minimum.
 *
 * **A category with no floor is the case §3.4.3 cannot literally answer** — there
 * is no "minimum booking total" to evaluate at — so the honest reading is that
 * arbitrarily small bookings are possible and the smallest realistic one decides.
 * A pound is that probe, and it is deliberately the same figure
 * `scripts/unit-economics.mjs` has always used, so the report and the rule cannot
 * disagree about a category neither of them can defend.
 */
export const NO_FLOOR_PROBE: MoneyValue = { amount: 100, currency: 'GBP' };

/**
 * How busy the owner is assumed to be when the rule is judged.
 *
 * **One booking per active owner per month, deliberately the most pessimistic
 * level.** Stripe Connect charges £2 per active connected account per month, and
 * that cost is amortised across an owner's bookings — so judging at a busier
 * level would pass the gate by assuming the traction the gate exists to survive
 * the absence of. An owner who has just listed their first item has completed one
 * booking that month by definition.
 */
export const RULE_ACTIVITY_LEVEL = 1;

/** Whether a category's fees clear §3.4.3, and why not when they do not. */
export interface MarginVerdict {
  readonly meetsRule: boolean;
  /** The booking the rule was judged at — the floor, or {@link NO_FLOOR_PROBE}. */
  readonly judgedAt: MoneyValue;
  readonly contributionMargin: MoneyValue;
  /**
   * A sentence naming the cause, present only when the rule is not met.
   *
   * **It reaches an administrator**, so it says what is wrong and what would fix
   * it. A category refused with "invalid configuration" is a category somebody
   * edits at random until it saves.
   */
  readonly reason?: string;
}

/**
 * Judge a fee policy against §3.4.3.
 *
 * **Pure, and it takes the cost model rather than reaching for it**, so a test
 * can prove the rule against a model whose numbers it chose — and so a future
 * non-UK cost model is a parameter rather than a fork. {@link meetsMarginRule}
 * is the one-argument form callers use.
 */
export function marginVerdictFor(
  policy: CategoryFeePolicy,
  model: CostModel,
): MarginVerdict {
  const hasFloor = policy.minimumBookingTotal.amount > 0;
  const judgedAt = hasFloor ? policy.minimumBookingTotal : NO_FLOOR_PROBE;

  const economics = unitEconomicsOf(
    {
      grossBookingValue: judgedAt,
      /*
       * **Nothing captured, which is the ordinary booking and the right one to
       * judge.** §8.7.2's hold is authorised at the collection window and most
       * are never taken; a rule judged against a damaged return would be asking
       * whether the category survives its worst day rather than its normal one.
       */
      damageSecurityCaptured: { amount: 0, currency: judgedAt.currency },
      bookingsPerActiveOwnerPerMonth: RULE_ACTIVITY_LEVEL,
    },
    policy,
    model,
  );

  const margin = economics.contributionMargin;
  if (!Money.isNegative(margin)) {
    return { meetsRule: true, judgedAt, contributionMargin: margin };
  }

  /*
   * **Two different sentences, because they have two different fixes.** A
   * category with a floor is losing money on a booking it permits; one without a
   * floor is losing money on a booking nobody has permitted and nobody can
   * prevent. Telling an administrator to "raise the fees" in the second case
   * sends them to the wrong control.
   */
  return {
    meetsRule: false,
    judgedAt,
    contributionMargin: margin,
    reason: hasFloor
      ? `at its minimum booking total of ${describe(judgedAt)} this category ` +
        `loses ${describe(Money.negate(margin))} per booking`
      : `this category sets no minimum booking total, so nothing stops a ` +
        `booking as small as ${describe(judgedAt)}, which would lose ` +
        `${describe(Money.negate(margin))}`,
  };
}

/** {@link marginVerdictFor} against the cost model we actually trade under. */
export function meetsMarginRule(policy: CategoryFeePolicy): MarginVerdict {
  return marginVerdictFor(policy, UK_STRIPE_COST_MODEL);
}

/**
 * Pounds and pence, for a sentence an administrator reads.
 *
 * **`Money.format`, not arithmetic on the minor units.** The obvious version —
 * dividing by a hundred and calling `toFixed(2)` — is banned by
 * `no-tofixed` (ADR 0002), and the invariant checker caught exactly that here.
 * Nothing would have gone wrong at these magnitudes, which is the point: the rule
 * exists because that habit is how a float reaches a total, and a file that
 * decides whether a category may trade is the worst place to practise it.
 */
function describe(value: MoneyValue): string {
  return Money.format(Money.money(value.amount, value.currency));
}
