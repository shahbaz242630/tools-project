import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { basisPointsToPercent } from '@platform/contracts';

/**
 * The renter's mandatory fee on a charge, and whether the floor bound it
 * (BRD §3.4.2, §3.4.4).
 *
 * **Extracted in slice 4.4b because it now has two callers**, and BRD §6.1 says
 * the rounding rule exists once: `inclusiveDailyPrice` applies it to one day for
 * the listing page's indicative figure, and the quote engine applies it to a
 * whole period. Two copies of "percentage, then floor" is how a listing page and
 * a quote come to disagree about the fee on the same listing — a difference
 * nobody would notice until a renter compared the two screens.
 */

export interface RenterFee {
  readonly fee: MoneyValue;
  /**
   * Whether the category's minimum platform fee bound rather than the
   * percentage.
   *
   * Carried rather than inferred, so a caller can be honest about what "from"
   * means: when the floor binds, a longer rental genuinely does cost less per
   * day.
   */
  readonly minimumFeeApplied: boolean;
}

export function renterFeeOn(charge: MoneyValue, policy: CategoryFeePolicy): RenterFee {
  /*
   * The percentage, rounded once, here.
   *
   * `percentageOf` rounds half-up to a whole penny, which is the platform's
   * single rounding rule (§6.1). Rounding again anywhere downstream — a display
   * helper formatting to two places, a component adding two rounded numbers — is
   * how a total stops equalling the sum of its parts.
   */
  const percentageFee = Money.percentageOf(
    charge,
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
   * **The floor is per *booking*, not per day**, which is why it matters that
   * this function is given a whole period's charge by the quote engine and one
   * day's rate by the indicative figure. A floor applied per day would multiply a
   * £1 minimum fee into £14 on a fortnight, which is not what §3.4.2 describes.
   * It is also why the indicative price is labelled "from": on a cheap listing
   * the floor binds hardest on the shortest hire.
   *
   * When Phase 5 decides the allocation, this is the line that changes, and the
   * displayed price can only fall.
   */
  const minimumFeeApplied = Money.lessThan(percentageFee, floor);

  return {
    fee: minimumFeeApplied ? floor : percentageFee,
    minimumFeeApplied,
  };
}
