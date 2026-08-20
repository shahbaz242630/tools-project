import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { basisPointsToPercent } from '@platform/contracts';
import { LedgerError, apportion } from './ledger.js';
import type { LedgerEntryDraft } from './ledger.js';

/**
 * How a hire's money divides between the owner and the platform (BRD §3.4, §8.7,
 * slice 5.2a).
 *
 * **Pure, and it is where the only arithmetic in Phase 5 lives.** ADR 0002 puts
 * rounding in one place per calculation; this is that place for a settlement, and
 * `ledger.ts` deliberately has none — a ledger that could compute a share could
 * compute it differently from whatever quoted it.
 */

/** What each party gets from one hire. */
export interface HireSettlement {
  /** What the renter is charged. Always the booking's stored total. */
  readonly renterPays: MoneyValue;
  /** What the owner is owed, before any payout. */
  readonly ownerEarns: MoneyValue;
  /** The platform's revenue: the renter's fee plus the owner's commission. */
  readonly platformEarns: MoneyValue;
  /** The commission taken from the owner's side, kept for the payout statement. */
  readonly ownerCommission: MoneyValue;
}

/** The money a booking was made under (§8.2), as stored on its row. */
export interface HireCharge {
  readonly itemCharge: MoneyValue;
  readonly renterFee: MoneyValue;
  readonly total: MoneyValue;
}

/**
 * Divide a hire's money.
 *
 * **The owner's share is computed and the platform's is derived by subtraction,
 * never the other way and never both independently.** That is ADR 0002's whole
 * lesson applied to a three-way split: two independently rounded shares do not
 * reliably sum to the total, and a penny invented here is a ledger that does not
 * balance and a reconciliation that fails every day for no discoverable reason.
 * Deriving the second share makes conservation structural rather than tested.
 *
 * **The fee policy must be the booking's pinned category version, not the current
 * one** (§8.2). A booking keeps the terms it was made under, and re-reading
 * today's commission would pay an owner a rate nobody agreed to. `bookings.
 * categoryVersionId` exists for this, and `category_versions` is immutable, so
 * the number is provable years later.
 *
 * **The minimum-fee floor is already inside `renterFee`** and is not re-applied
 * here. `pricing/renter-fee.ts` records why the whole floor currently lands on
 * the renter and notes that Phase 5 may reallocate it — **but that decision can
 * only change future quotes.** §8.2 binds this function to what the renter was
 * shown, so a booking already made settles on its own stored numbers whatever is
 * decided later.
 */
export function settleHire(
  charge: HireCharge,
  policy: CategoryFeePolicy,
): HireSettlement {
  const currency = charge.total.currency;

  if (
    charge.itemCharge.currency !== currency ||
    charge.renterFee.currency !== currency
  ) {
    throw new LedgerError(
      'a hire cannot be settled from amounts in different currencies',
    );
  }

  /*
   * The stored total must be its own parts. It is written by the quote engine and
   * copied onto the booking, so a mismatch means the row is wrong — and posting
   * from a wrong row would put the error in the ledger, where §8.7 makes it
   * permanent. Refusing is the only safe answer.
   */
  const parts = Money.add(charge.itemCharge, charge.renterFee);
  if (parts.amount !== charge.total.amount) {
    throw new LedgerError(
      `a hire's total ${charge.total.amount} is not its parts ${parts.amount}: refusing to settle from a row that disagrees with itself`,
    );
  }

  // Rounded once, here (§6.1).
  const ownerCommission = Money.percentageOf(
    charge.itemCharge,
    basisPointsToPercent(policy.ownerCommissionBasisPoints),
  );

  const ownerEarns = Money.subtract(charge.itemCharge, ownerCommission);
  const platformEarns = Money.subtract(charge.total, ownerEarns);

  return {
    renterPays: charge.total,
    ownerEarns,
    platformEarns,
    ownerCommission,
  };
}

/**
 * The ledger entries a settled hire produces.
 *
 * Money arrives at the provider and is apportioned between what we owe the owner
 * and what we have earned — which is why `owner_payable` is a **liability**:
 * §8.7 holds the owner's payout until return confirmation, so between capture and
 * payout the money is ours to hold and theirs to receive.
 *
 * `apportion` refuses shares that do not sum to what moved, so this cannot
 * produce an unbalanced transaction even if `settleHire` were wrong.
 */
export function hireCaptureEntries(input: {
  readonly settlement: HireSettlement;
  readonly providerClearingAccountId: string;
  readonly ownerPayableAccountId: string;
  readonly platformRevenueAccountId: string;
}): LedgerEntryDraft[] {
  const { settlement } = input;

  /*
   * **A zero share is omitted rather than posted, and this is not hypothetical.**
   * Fees are versioned configuration and both rates may legitimately be zero — a
   * category configured with no commission and no renter fee is a valid thing for
   * an administrator to create. A zero-amount entry is refused by
   * `assertPostable` (the direction carries the sign, so an amount must be
   * positive), which would make the whole posting fail and leave a perfectly
   * ordinary booking unpayable. Omitting it records the same truth with one
   * fewer row.
   */
  const shares = [
    {
      accountId: input.ownerPayableAccountId,
      amount: settlement.ownerEarns,
    },
    {
      accountId: input.platformRevenueAccountId,
      amount: settlement.platformEarns,
    },
  ].filter((share) => share.amount.amount !== 0);

  return apportion({
    currency: settlement.renterPays.currency,
    from: {
      accountId: input.providerClearingAccountId,
      amount: settlement.renterPays,
    },
    to: shares,
  });
}
