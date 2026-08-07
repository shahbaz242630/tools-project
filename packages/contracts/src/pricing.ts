/**
 * What it costs to rent, and what the platform takes for arranging it.
 *
 * BRD §6.2 puts a **fee policy** on both `Category` and `Category version`, and
 * §8.2 lists "fees, minimum booking total, minimum platform fee" among the
 * configuration an administrator sets without a deploy. This file is the shape
 * of that policy; slice 2.7b adds the listing's own rates and the service that
 * resolves the two into a price somebody may legally be shown.
 *
 * **Its own file, named for the whole concern rather than for what is in it
 * today.** That is 2.5b's lesson repeated deliberately: `search-location/` was
 * named for the module so Phase 3's radius query would inherit its exemption
 * rather than need one. Everything priced after this — the rate card in 2.7b,
 * the quote engine in Phase 4, the fee split in Phase 5 — belongs here, and a
 * file called `fees.ts` would have collected them under a name that describes a
 * third of what it holds.
 *
 * **Nothing in this file names a category, a rate or a threshold.** §1.2's rule:
 * fee percentages are versioned configuration, never code. The only numbers here
 * are bounds on what an administrator may type, and the band §3.4 recommends —
 * which is guidance the form shows, not a limit the validator enforces. The
 * distinction matters and is the same one `MAX_CATEGORY_ATTRIBUTES` draws
 * against `RECOMMENDED_MAX_CATEGORY_ATTRIBUTES`: confusing a commercial finding
 * with a constraint makes it un-liftable without a deploy.
 */

import { z } from 'zod';
import { moneySchema } from './money.js';
import type { MoneyInput } from './money.js';
import { parseWith } from './parse.js';

/**
 * Fee rates are held in **basis points** — hundredths of a percent, as a whole
 * number. 15% is `1500`.
 *
 * **Not a decimal fraction, for ADR 0002's reason applied one step earlier than
 * usual.** The money invariant bans floats from amounts; a rate is not an
 * amount, but it is the thing an amount gets multiplied by, so a float here
 * lands in the ledger just as surely. `0.15` cannot be represented exactly in
 * binary floating point, and `rate * total` inherits that error before any
 * rounding rule gets a chance to be careful about it.
 *
 * Basis points rather than whole percent because 12.5% is a rate somebody will
 * eventually want and a percent-granular field would force it to be 12 or 13 —
 * a 0.5% error on every booking, introduced by a validator, discovered by
 * whoever reconciles the ledger.
 */
export const BASIS_POINTS_PER_UNIT = 10_000;

/**
 * The ceiling on a configurable fee rate: 50%.
 *
 * **A hard bound, not a policy.** It exists so a typo cannot configure a
 * category that takes more than half of every booking, and it sits far above
 * anything §3.4 contemplates. The commercially sensible band is below, as
 * guidance — the form shows it, nothing enforces it, and a deliberate decision
 * to move outside it must not require a deploy.
 */
export const MAX_FEE_BASIS_POINTS = 5_000;

/**
 * What §3.4 actually recommends, for the form to show and for nothing to
 * enforce: 12–20% owner commission, 5–12% renter fee.
 *
 * These are the ranges the unit-economics work arrived at, and the BRD is
 * explicit that they carry **no public commitment** — Hygglo cut fees by around
 * 40% and can undercut us, so price is not the wedge. They live here rather than
 * in the admin form because §3.4.3's worked example will read them too.
 */
export const RECOMMENDED_OWNER_COMMISSION_BASIS_POINTS = {
  minimum: 1_200,
  maximum: 2_000,
} as const;

export const RECOMMENDED_RENTER_FEE_BASIS_POINTS = {
  minimum: 500,
  maximum: 1_200,
} as const;

/**
 * A rate an administrator may configure.
 *
 * **Zero is allowed and is not a mistake.** A promotional category, a
 * supply-first launch pushing owners onto the platform, or a category run at
 * cost are all real reasons to take nothing — and refusing zero would mean the
 * only way to express it is a deploy. Negative is refused: a fee that pays the
 * counterparty is not a fee, and if that is ever wanted it is an incentive with
 * its own ledger treatment rather than a sign flip on this field.
 */
export const feeBasisPointsSchema = z
  .number()
  .int('must be a whole number of basis points — 15% is 1500')
  .min(0, 'cannot be negative')
  .max(
    MAX_FEE_BASIS_POINTS,
    `cannot exceed ${MAX_FEE_BASIS_POINTS / 100}% — that is a hard limit, not the recommended band`,
  );

/**
 * Turn basis points into the percentage `Money.percentageOf` expects.
 *
 * One function rather than `/ 100` at each call site, because the two units are
 * easy to confuse and the confusion is silent: `percentageOf(total, 1500)` is a
 * well-typed call that charges fifteen times the booking value. Naming the
 * conversion makes the unit change visible at the point it happens.
 *
 * The division is exact for every value this schema admits — basis points are
 * integers and 100 is a power of ten — so no float error is introduced here.
 * The multiplication that follows is `Money`'s, which rounds to a whole penny
 * under a stated mode.
 */
export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / 100;
}

/**
 * The fee policy a category version carries.
 *
 * **On the version, never on the category**, for the reason §8.2 gives and
 * ADR 0028 already applied to the reportable-activity flag: a booking must be
 * readable under the terms it was made under. A rate stored where it can be
 * overwritten answers "what do we charge now"; a payout dispute eighteen months
 * later needs "what did we charge then", and only the immutable version row can
 * answer that.
 */
export interface CategoryFeePolicy {
  /**
   * What the platform retains from the owner's side, in basis points.
   *
   * §3.4 models this as commission deducted from the owner's payout rather than
   * added to the renter's bill, which is why it does not appear in the
   * inclusive total §3.4.4 governs — the renter never pays it. It still belongs
   * in configuration because §3.4.3's contribution-margin gate reads both sides.
   */
  readonly ownerCommissionBasisPoints: number;

  /**
   * What the renter pays on top of the item rate, in basis points.
   *
   * **This is the one §3.4.4 makes a legal matter.** It is a mandatory fee, so
   * every price shown anywhere — search results, listing cards, listing pages,
   * quotes — must already include it. Displaying the bare rate and adding this
   * at checkout is the drip pricing the DMCC regime is actively enforcing
   * against.
   */
  readonly renterFeeBasisPoints: number;

  /**
   * The booking total below which a booking may not be submitted (§3.4.2).
   *
   * Configuration here, enforcement in Phase 4 — this is a rule about a
   * *booking*, and there is no booking in Phase 2 to refuse. Recorded now
   * because it is category configuration and belongs on the same immutable row
   * as the rates it exists to protect: on a small enough booking the fixed
   * per-transaction costs in §3.4.1 exceed the percentage revenue entirely.
   */
  readonly minimumBookingTotal: MoneyInput;

  /**
   * The floor under the platform fee, applied when the percentage falls below
   * it (§3.4.2).
   *
   * Unlike the total above, this **is** pricing logic and 2.7b's resolver
   * applies it: 8% of a £6 day is 48p, which does not cover the card processing
   * on it. The floor is what stops a category being configured into a loss one
   * cheap listing at a time.
   */
  readonly minimumPlatformFee: MoneyInput;
}

/**
 * Both amounts must be in the same currency, and the fee floor must not exceed
 * the booking floor.
 *
 * The second is a real invariant rather than tidiness: a minimum platform fee
 * above the minimum booking total describes a category where the smallest
 * permissible booking pays the platform more than the whole booking is worth,
 * leaving the owner a negative payout. It is unreachable by any sensible pair of
 * numbers and trivially reachable by a typo, which is exactly what a validator
 * is for.
 *
 * **The consequence worth stating, because an administrator will meet it:
 * setting a fee floor requires setting a booking floor at least as large.** A
 * £1 minimum fee with no minimum booking total is not the harmless combination
 * it looks like — it prices a 50p booking at £1 of fees. §3.4.2 introduces the
 * two together for that reason, and refusing the pair here is what makes an
 * administrator decide them together rather than one at a time.
 */
function checkFloorsAgree(
  policy: {
    readonly minimumBookingTotal: MoneyInput;
    readonly minimumPlatformFee: MoneyInput;
  },
  ctx: z.RefinementCtx,
): void {
  /*
   * **Unreachable while the platform supports one currency, and kept anyway.**
   *
   * `currencyCodeSchema` is an enum over `SUPPORTED_CURRENCIES`, today `['GBP']`,
   * so a mismatched pair is refused before this function runs and no test can
   * reach this branch honestly. Deleting it would mean the day a second currency
   * is added, the comparison below silently compares 500 pence against 500 cents
   * — a rule that passes without ever having fired. `c8 ignore` rather than a
   * test that would pass for the wrong reason.
   */
  /* c8 ignore next 9 */
  if (policy.minimumBookingTotal.currency !== policy.minimumPlatformFee.currency) {
    ctx.addIssue({
      code: 'custom',
      message:
        'The minimum booking total and the minimum platform fee must be in the same currency',
      path: ['minimumPlatformFee', 'currency'],
    });
    return;
  }

  /*
   * **The message names its own subject**, because its path never can.
   * `feePolicy.minimumPlatformFee.amount` is three segments of internal
   * structure against a field labelled "Minimum platform fee (£)". The same
   * defect 2.4b and 2.4c-i each found and fixed one field at a time; the rule
   * that retires it for good is in `contract-issues.ts` — a message that is a
   * sentence is shown alone, a fragment is prefixed with its path.
   */
  if (policy.minimumPlatformFee.amount > policy.minimumBookingTotal.amount) {
    ctx.addIssue({
      code: 'custom',
      message:
        'The minimum platform fee cannot be more than the minimum booking total — ' +
        'the platform would take more than the booking is worth',
      path: ['minimumPlatformFee', 'amount'],
    });
  }
}

/**
 * A ceiling on the two configurable floors, so a typo cannot make a category
 * unbookable.
 *
 * £10,000 in pence. A minimum booking total of a million pounds is not a policy
 * anybody meant, and the failure it produces — every booking refused, with a
 * message about a minimum — reads as a broken platform rather than as a
 * misconfiguration.
 */
export const MAX_PRICING_FLOOR_MINOR_UNITS = 1_000_000;

const pricingFloorSchema = moneySchema.superRefine((value, ctx) => {
  if (value.amount < 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'cannot be negative',
      path: ['amount'],
    });
  }
  if (value.amount > MAX_PRICING_FLOOR_MINOR_UNITS) {
    ctx.addIssue({
      code: 'custom',
      message: `cannot exceed £${MAX_PRICING_FLOOR_MINOR_UNITS / 100}`,
      path: ['amount'],
    });
  }
});

export const categoryFeePolicySchema = z
  .object({
    ownerCommissionBasisPoints: feeBasisPointsSchema,
    renterFeeBasisPoints: feeBasisPointsSchema,
    minimumBookingTotal: pricingFloorSchema,
    minimumPlatformFee: pricingFloorSchema,
  })
  .superRefine(checkFloorsAgree);

export function parseCategoryFeePolicy(raw: unknown): CategoryFeePolicy {
  return parseWith(categoryFeePolicySchema, 'The fee policy', raw);
}

/**
 * What a category configured before this slice carries.
 *
 * **Zero rates and zero floors, not a guessed percentage.** The same call every
 * configuration addition in this phase has made: the attribute schema defaulted
 * to empty, the transport options defaulted to none, and neither invented
 * something nobody chose. A backfilled 15% would be a fee an administrator never
 * agreed to, sitting on an immutable row, indistinguishable from one they did.
 *
 * Zero is safe in a way a guess is not: it charges nobody anything, and §8.2
 * already forbids enabling a category for public booking before §3.4.3's worked
 * example exists — so a category still carrying these values cannot reach a
 * renter without somebody having looked at the numbers.
 */
export const UNCONFIGURED_FEE_POLICY: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 0,
  renterFeeBasisPoints: 0,
  minimumBookingTotal: { amount: 0, currency: 'GBP' },
  minimumPlatformFee: { amount: 0, currency: 'GBP' },
};

/**
 * Whether this policy has actually been configured, as opposed to defaulted.
 *
 * Read by the admin list, so a category nobody has priced is visibly distinct
 * from one priced at zero deliberately — 2.4c-i's finding that "configuration
 * invisible in the list is configuration nobody checks". It deliberately reads
 * only the rates: a category may legitimately set no floors, but one that takes
 * no fee on either side has not been through §3.4.3.
 */
export function isFeePolicyConfigured(policy: CategoryFeePolicy): boolean {
  return policy.ownerCommissionBasisPoints > 0 || policy.renterFeeBasisPoints > 0;
}

/**
 * What a listing costs to rent, before any platform fee (BRD §8.5.2, §8.3).
 *
 * **Every rate is nullable, because §8.3 makes a draft permissive.** An owner
 * saves progress; completeness is a publication rule and belongs to slice 2.8,
 * which must refuse to publish a listing with no daily rate for the same reason
 * it must refuse one with no coordinates — it would be a listing nothing could
 * price and nobody could book.
 */
export interface ListingRateCard {
  /**
   * The spine. Every other rate is an alternative to it, and it is the one the
   * inclusive headline is computed from.
   */
  readonly daily: MoneyInput | null;
  /**
   * Friday to Sunday as one charge, which is how most domestic tool hire
   * actually happens — §8.5.2 names it separately from a two-day daily charge
   * precisely because it is not one.
   */
  readonly weekend: MoneyInput | null;
  readonly weekly: MoneyInput | null;
}

/**
 * **Hourly is deliberately absent, and this is the note that says so.**
 *
 * §8.5.2 names "daily, hourly, weekend, weekly and configurable discounts". The
 * other three are here. Hourly is not, because in a peer-to-peer model the
 * renter drives to a stranger's house to collect — the round trip alone exceeds
 * the rental — and nothing in the launch category is rented by the hour. An
 * unused rate is not free: it is a case every consumer from the quote engine to
 * the booking summary must handle forever, and a field on the listing form that
 * makes an owner wonder whether they should fill it in.
 *
 * It is a column and a form field away if a later category wants it. Adding one
 * is cheaper than carrying a rate nobody sets through four phases.
 *
 * **Configurable discounts are absent for a different reason**: a discount
 * applies to a *duration*, and there are no dates in Phase 2. They belong with
 * the quote engine in Phase 4, where a period exists to discount.
 */
export const MIN_RENTAL_RATE_MINOR_UNITS = 100;
export const MAX_RENTAL_RATE_MINOR_UNITS = 1_000_000;

/**
 * Platform-wide sanity bounds, not policy — the same call
 * `replacementValueSchema` makes and for the same reason. The easy mistake is
 * entering pounds where pence are meant, a factor of a hundred, so the range is
 * wide enough to be uncontroversial and narrow enough to catch that.
 *
 * A per-category cap belongs in category configuration beside the deposit bands
 * §8.2 already promises. Putting one here would hard-code a commercial limit in
 * a validator.
 */
export const rentalRateSchema = moneySchema.superRefine((value, ctx) => {
  if (value.amount < MIN_RENTAL_RATE_MINOR_UNITS) {
    ctx.addIssue({
      code: 'custom',
      message: `must be at least £${MIN_RENTAL_RATE_MINOR_UNITS / 100}`,
      path: ['amount'],
    });
  }
  if (value.amount > MAX_RENTAL_RATE_MINOR_UNITS) {
    ctx.addIssue({
      code: 'custom',
      message: `must be at most £${MAX_RENTAL_RATE_MINOR_UNITS / 100}`,
      path: ['amount'],
    });
  }
});

export const listingRateCardSchema = z
  .object({
    daily: rentalRateSchema.nullable(),
    weekend: rentalRateSchema.nullable(),
    weekly: rentalRateSchema.nullable(),
  })
  .superRefine((rates, ctx) => {
    /*
     * A weekly rate above seven daily charges, or a weekend above three, is not
     * refused — it is *warned about* nowhere and stored happily, because a rate
     * card is the owner's commercial decision and a validator that second-
     * guessed it would be hard-coding a pricing opinion (§1.2). What is refused
     * is only what cannot be interpreted.
     *
     * The one real rule: a weekend or weekly rate with no daily rate beside it
     * describes a listing that can be rented for three days but not one, with
     * nothing saying so. §8.5.2's quote engine has no way to express that, and
     * 2.8's publication rule would have to invent a meaning for it.
     */
    if (rates.daily === null && (rates.weekend !== null || rates.weekly !== null)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'A daily rate is needed before a weekend or weekly rate — the others are ' +
          'alternatives to it, not replacements for it',
        path: ['daily'],
      });
    }
  });

export type ListingRateCardInput = z.infer<typeof listingRateCardSchema>;

export function parseListingRateCard(raw: unknown): ListingRateCard {
  return parseWith(listingRateCardSchema, 'The rates', raw);
}

/** A listing nobody has priced yet. What every listing created before 2.7b has. */
export const UNPRICED_RATE_CARD: ListingRateCard = {
  daily: null,
  weekend: null,
  weekly: null,
};

/**
 * What §3.4.4 requires to be shown, and the parts it requires to be shown
 * separately.
 *
 * **`total` is the headline and the only figure that may be displayed largest.**
 * Showing `rate` as the price and adding `renterFee` later is the drip pricing
 * the DMCC regime is actively enforcing against — §3.4.4 is explicit that it is
 * prohibited, not discouraged.
 *
 * The breakdown is carried beside it because §3.4.4 permits a base price shown
 * *alongside* an inclusive total, and because an owner setting a rate needs to
 * see what their renter actually pays.
 */
export interface InclusiveDailyPrice {
  /** What the owner asked for, before any platform fee. */
  readonly rate: MoneyInput;
  /**
   * The renter's mandatory fee on a **one-day** rental, after the category's
   * minimum platform fee has been applied.
   *
   * The owner's commission is deliberately not here: §3.4 deducts it from the
   * owner's payout, so the renter never pays it and it has no place in a figure
   * governed by a price-transparency rule.
   */
  readonly renterFee: MoneyInput;
  /** `rate + renterFee`. The headline. */
  readonly total: MoneyInput;
  /**
   * Whether the category's minimum platform fee bound rather than the
   * percentage.
   *
   * Carried so the interface can be honest about what "from" means: when the
   * floor binds, a longer rental genuinely does cost less per day, and that is
   * the difference between a helpful "from" and a misleading one.
   */
  readonly minimumFeeApplied: boolean;
}

/**
 * The response check on a computed price.
 *
 * Shape-only, deliberately. It does **not** re-derive the total from the parts:
 * a check that recomputed would be a second implementation of the rounding rule
 * §6.1 says exists once, and the two would disagree the first time either
 * changed. What it pins is that the API sent three amounts and a flag, in the
 * shape everything downstream reads.
 */
export const inclusiveDailyPriceSchema = z.object({
  rate: moneySchema,
  renterFee: moneySchema,
  total: moneySchema,
  minimumFeeApplied: z.boolean(),
});
