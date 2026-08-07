import { Money } from '@platform/core';
import type {
  CategoryFeePolicy,
  InclusiveDailyPrice,
  ListingRateCard,
} from '@platform/contracts';
import { basisPointsToPercent } from '@platform/contracts';

/**
 * The one place a price is worked out, and the only place rounding happens.
 *
 * BRD §6.1 is binding on both halves of that sentence: *"Rounding rules are
 * defined once in the pricing service and applied consistently; rounding is
 * never left to the presentation layer."* Everything that displays a price asks
 * this module and renders what it gets back.
 *
 * **The module is `pricing/` rather than a file inside `catalogue/`**, and that
 * is a departure from BRD §5.1's module table, which has no pricing module —
 * fees sit under Payments & Ledger, which is Phase 5. ADR 0034 records why: the
 * rounding rule §6.1 requires needs one home now, Phase 4's quote engine and
 * Phase 5's fee split belong beside it, and naming the folder for the whole
 * concern is what stopped `search-location/` needing to be renamed when Phase 3
 * arrived.
 *
 * **It has no ports and no store, deliberately.** A price is a function of a
 * rate card and a fee policy, both of which the caller already holds — Catalogue
 * reads the listing and its pinned category version in one query. Giving this
 * module its own repository would mean two modules reading the same rows and
 * disagreeing about which version was pinned.
 */

/**
 * What a renter pays to have this item for one day, inclusive of the mandatory
 * platform fee (§3.4.4).
 *
 * Returns null when the listing has no daily rate, which is every draft that has
 * not been priced. **Null means "do not display a price", never "free"** — the
 * caller renders the absence, and slice 2.8 refuses to publish such a listing at
 * all.
 *
 * ## Why one day, and why "from"
 *
 * Phase 2 has no dates. §8.5.2 says a quote is a function of listing, dates
 * **and renter postcode**, and none of those exist here — so this is the
 * *indicative* figure §8.5.2 explicitly permits before a postcode is supplied,
 * on the condition that it still satisfies §3.4.4 for the location-independent
 * mandatory fees. That is exactly what this computes.
 *
 * One day rather than an average, because one day is the **cheapest possible
 * booking** and therefore the only duration whose inclusive price cannot be an
 * understatement of what somebody will actually be charged. Understating is the
 * §3.4.4 exposure; a longer rental costing less per day is what the word "from"
 * is doing in the display.
 */
export function inclusiveDailyPrice(
  rates: ListingRateCard,
  policy: CategoryFeePolicy,
): InclusiveDailyPrice | null {
  if (rates.daily === null) return null;

  const rate = Money.money(rates.daily.amount, rates.daily.currency);

  /*
   * The percentage, rounded once, here.
   *
   * `percentageOf` rounds half-up to a whole penny, which is the platform's
   * single rounding rule (§6.1). Rounding again anywhere downstream — a display
   * helper formatting to two places, a component adding two rounded numbers —
   * is how a total stops equalling the sum of its parts.
   */
  const percentageFee = Money.percentageOf(
    rate,
    basisPointsToPercent(policy.renterFeeBasisPoints),
  );

  const floor = Money.money(
    policy.minimumPlatformFee.amount,
    policy.minimumPlatformFee.currency,
  );

  /*
   * **The floor is applied to the renter's fee, and that is deliberately the
   * conservative reading of §3.4.2.**
   *
   * §3.4.2 puts a minimum on *the platform fee*, and the platform's revenue on a
   * booking is the owner's commission plus the renter's fee. Which side makes up
   * a shortfall is a payout question — it changes what the owner receives — and
   * payouts are Phase 5. Nothing here is entitled to decide it.
   *
   * So this takes the bound that cannot be wrong in the direction that matters:
   * applying the whole floor to the renter's side can only ever *overstate* what
   * they will be charged relative to any allocation Phase 5 chooses. If Phase 5
   * makes the owner absorb part of it, the renter pays less than was displayed,
   * which is safe. The opposite — displaying less than they pay — is the drip
   * pricing §3.4.4 prohibits.
   *
   * When Phase 5 decides the allocation, this is the line that changes, and the
   * displayed price can only fall.
   */
  const minimumFeeApplied = Money.lessThan(percentageFee, floor);
  const renterFee = minimumFeeApplied ? floor : percentageFee;

  return {
    rate,
    renterFee,
    total: Money.add(rate, renterFee),
    minimumFeeApplied,
  };
}
