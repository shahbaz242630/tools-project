import { Money } from '@platform/core';
import type {
  CategoryFeePolicy,
  InclusiveDailyPrice,
  ListingRateCard,
} from '@platform/contracts';
import { renterFeeOn } from './renter-fee.js';

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
   * **The percentage-then-floor rule lives in `renter-fee.ts`**, and did not
   * until slice 4.4b. It was inline here while this was its only caller; the
   * quote engine is the second, applying the same rule to a whole period, and
   * §6.1 says the rounding rule exists once. The reasoning for the floor going
   * entirely on the renter's side — and for what Phase 5 changes about it — is
   * in that file.
   */
  const { fee: renterFee, minimumFeeApplied } = renterFeeOn(rate, policy);

  return {
    rate,
    renterFee,
    total: Money.add(rate, renterFee),
    minimumFeeApplied,
  };
}
