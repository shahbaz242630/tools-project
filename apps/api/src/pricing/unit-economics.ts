/**
 * What the platform actually earns on a booking (BRD §3.4.1, §3.4.3, slice 5.3a).
 *
 * **Pure, and every input is passed in** — no database, no clock, no provider.
 * The shape 4.1 gave §7's state machine and 5.2a gave the settlement maths, and
 * here it is what lets the whole model be swept across booking values and owner
 * activity without a fixture.
 *
 * ## The one thing to understand before reading the arithmetic
 *
 * **Revenue is fixed per booking and the largest cost is not.** Stripe Connect
 * charges **£2 per active connected account per month** — not per booking — so it
 * is amortised across however many bookings that owner completes in the month.
 * The same £2 is 200p of cost on a booking if the owner lets once a month and 25p
 * if they let eight times.
 *
 * That makes `bookingsPerActiveOwnerPerMonth` the most consequential number in
 * the model, and **it is a number nobody has measured** — there is no trading
 * history. So `contributionMarginAcross` exists to answer the question as a
 * *curve* rather than a point: it reports where margin crosses zero, which is a
 * fact about the fee configuration rather than a guess about owner behaviour.
 *
 * ## Money rules
 *
 * Integer minor units throughout (ADR 0002). **Nothing here uses `allocate`**,
 * deliberately — allocation exists to split one amount across shares without
 * inventing a penny, and this file splits nothing: it *sums independent costs*,
 * each genuinely rounded on its own because each is genuinely charged on its own.
 * Rounding a provider's fee as though it were a share of ours would understate it.
 */

import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { basisPointsToPercent } from '@platform/contracts';
import type { CategoryFeePolicy } from '@platform/contracts';
import { applyRate } from './cost-model.js';
import type { CostModel } from './cost-model.js';
import { renterFeeOn } from './renter-fee.js';

/** One booking's worth of trading, as §3.4.3 wants it shown. */
export interface UnitEconomics {
  /** §3.4.3's "gross booking value" — the hire charge at the owner's rates. */
  readonly grossBookingValue: MoneyValue;
  /** What the renter pays in total, which is what the card is charged. */
  readonly renterPays: MoneyValue;

  readonly renterFee: MoneyValue;
  readonly ownerCommission: MoneyValue;
  /** What the owner receives. */
  readonly ownerProceeds: MoneyValue;
  /** Renter fee plus owner commission. */
  readonly platformRevenue: MoneyValue;

  readonly costs: CostBreakdown;
  readonly totalCost: MoneyValue;

  /** §3.4.3's "contribution margin". Negative is the thing that matters. */
  readonly contributionMargin: MoneyValue;

  /**
   * Whether §3.4.2's minimum platform fee had to be applied.
   *
   * Worth reporting because it is the mechanism §3.4.2 provides for exactly this
   * problem, and a worked example that shows the floor binding is showing the
   * floor doing its job.
   */
  readonly minimumFeeApplied: boolean;
}

/** Each §3.4.1 component, so the worked example can show them rather than a total. */
export interface CostBreakdown {
  readonly cardProcessing: MoneyValue;
  readonly damageSecurityProcessing: MoneyValue;
  readonly payout: MoneyValue;
  readonly connectedAccount: MoneyValue;
  readonly extendedAuthorisation: MoneyValue;
  readonly identityVerification: MoneyValue;
  readonly sms: MoneyValue;
  readonly refunds: MoneyValue;
  readonly chargebacks: MoneyValue;
  readonly support: MoneyValue;
}

export interface BookingShape {
  /** The hire charge at the owner's rates, before any platform fee. */
  readonly grossBookingValue: MoneyValue;
  /**
   * The damage security captured, if any.
   *
   * **Zero until deposit bands exist.** §8.7.2's hold is authorised at the
   * collection window and most are never captured; this is the amount actually
   * taken, so a booking that ends well carries no cost here.
   */
  readonly damageSecurityCaptured: MoneyValue;
  /**
   * How many bookings the owner completes in the month the £2 is charged for.
   *
   * Must be at least 1 — a booking exists, so its owner was active.
   */
  readonly bookingsPerActiveOwnerPerMonth: number;
}

export class UnitEconomicsError extends Error {}

/**
 * The full picture for one booking.
 *
 * **The renter fee comes from `renterFeeOn`, not from a second implementation.**
 * That function owns §3.4.2's minimum-fee floor and the conservative reading of
 * who absorbs it; recomputing the fee here would let the model report a margin on
 * a price no renter is ever shown.
 */
export function unitEconomicsOf(
  booking: BookingShape,
  policy: CategoryFeePolicy,
  model: CostModel,
): UnitEconomics {
  if (booking.bookingsPerActiveOwnerPerMonth < 1) {
    /*
     * Not a clamp. A value below one says the owner was inactive in a month they
     * completed a booking in, which is not a pessimistic assumption — it is an
     * incoherent one, and it would understate the amortised account fee without
     * looking wrong.
     */
    throw new UnitEconomicsError(
      `An owner completing a booking is active that month, so bookingsPerActiveOwnerPerMonth must be at least 1, received ${String(booking.bookingsPerActiveOwnerPerMonth)}`,
    );
  }

  const gross = booking.grossBookingValue;
  const currency = gross.currency;

  const { fee: renterFee, minimumFeeApplied } = renterFeeOn(gross, policy);
  const ownerCommission = Money.percentageOf(
    gross,
    basisPointsToPercent(policy.ownerCommissionBasisPoints),
  );

  const renterPays = Money.add(gross, renterFee);
  const ownerProceeds = Money.subtract(gross, ownerCommission);
  const platformRevenue = Money.add(renterFee, ownerCommission);

  const cardProcessing = applyRate(model.cardProcessing.value, renterPays);

  /*
   * **Only when something was actually captured.** A hold that expires costs
   * nothing to process, and charging the fixed 20p against every booking would
   * invent a cost on the majority that end well.
   */
  const damageSecurityProcessing = Money.isZero(booking.damageSecurityCaptured)
    ? Money.zero(currency)
    : applyRate(model.damageSecurityProcessing.value, booking.damageSecurityCaptured);

  const payout = applyRate(model.payout.value, ownerProceeds);

  const connectedAccount = Money.multiply(
    model.connectedAccountMonthly.value,
    1 / booking.bookingsPerActiveOwnerPerMonth,
  );

  const sms = Money.multiply(
    model.smsPerMessage.value,
    model.criticalMessagesPerBooking.value,
  );

  /*
   * **A refund costs us the processing fee we already paid**, because Stripe does
   * not return it — their published pricing says the original transaction's fees
   * "are not returned". So the expected cost is that fee times how often it
   * happens, and it is a real cost of every booking rather than of the refunded
   * ones only.
   */
  const refunds = Money.multiply(cardProcessing, model.refundRate.value);

  /*
   * **A chargeback costs the dispute fee on top of the lost processing**, and the
   * processing half is already counted in `refunds` above only for refunds — a
   * disputed booking loses the fee too, so both halves are counted here.
   */
  const chargebacks = Money.multiply(
    Money.add(model.disputeFee.value, cardProcessing),
    model.chargebackRate.value,
  );

  const costs: CostBreakdown = {
    cardProcessing,
    damageSecurityProcessing,
    payout,
    connectedAccount,
    extendedAuthorisation: model.extendedAuthorisation.value,
    identityVerification: model.identityVerification.value,
    sms,
    refunds,
    chargebacks,
    support: model.supportPerBooking.value,
  };

  const totalCost = Money.sum(Object.values(costs), currency);

  return {
    grossBookingValue: gross,
    renterPays,
    renterFee,
    ownerCommission,
    ownerProceeds,
    platformRevenue,
    costs,
    totalCost,
    contributionMargin: Money.subtract(platformRevenue, totalCost),
    minimumFeeApplied,
  };
}

/**
 * Where contribution margin crosses zero as an owner gets busier.
 *
 * **The answer to a question nobody can answer with a single number.** The
 * connected-account fee is the only cost that falls as an owner lets more often,
 * so margin is monotonically increasing in `bookingsPerActiveOwnerPerMonth` —
 * which means there is a threshold, and reporting it is more useful than
 * reporting a margin computed from a guess.
 */
export function marginAcrossOwnerActivity(
  booking: Omit<BookingShape, 'bookingsPerActiveOwnerPerMonth'>,
  policy: CategoryFeePolicy,
  model: CostModel,
  activityLevels: readonly number[],
): readonly { readonly bookingsPerMonth: number; readonly economics: UnitEconomics }[] {
  return activityLevels.map((bookingsPerMonth) => ({
    bookingsPerMonth,
    economics: unitEconomicsOf(
      { ...booking, bookingsPerActiveOwnerPerMonth: bookingsPerMonth },
      policy,
      model,
    ),
  }));
}

/**
 * The fewest bookings a month an owner must complete for this booking value to
 * pay for itself, or null if it never does within the range searched.
 *
 * **Searched rather than solved algebraically**, because the fee floor makes
 * revenue a step function of the booking value and the arithmetic rounds at every
 * component. A closed form would be a second implementation of the model that
 * could disagree with it.
 */
export function breakEvenOwnerActivity(
  booking: Omit<BookingShape, 'bookingsPerActiveOwnerPerMonth'>,
  policy: CategoryFeePolicy,
  model: CostModel,
  searchUpTo = 60,
): number | null {
  for (let bookings = 1; bookings <= searchUpTo; bookings += 1) {
    const economics = unitEconomicsOf(
      { ...booking, bookingsPerActiveOwnerPerMonth: bookings },
      policy,
      model,
    );

    if (!Money.isNegative(economics.contributionMargin)) return bookings;
  }

  return null;
}
