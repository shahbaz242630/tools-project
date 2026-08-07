import { Money, MoneyError } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { MAX_FEE_BASIS_POINTS } from '@platform/contracts';

/**
 * The fee policy as an administrator types it, to the shape the contract stores.
 *
 * Beside `replacement-value.ts` and for its reasons: this is business logic, it
 * must be testable without dragging `next/headers` into a test, and a
 * `'use server'` file cannot be imported by one.
 *
 * **The form asks for a percentage and the server produces basis points.** That
 * is 2.4b's rule about scaled numbers applied to a second field: the client
 * sends what somebody typed, and the conversion to storage units happens once,
 * server-side, where the scale is known. A form posting basis points would be
 * supplying both the value and what the value means — and `1500` typed by
 * somebody who meant 15% is indistinguishable from `1500` meaning 1500%.
 *
 * Nobody thinks in basis points. Asking an administrator to is how you get a
 * category configured at 0.15%.
 */
export type FeePolicyInput =
  | { readonly ok: true; readonly value: CategoryFeePolicy }
  | { readonly ok: false; readonly message: string };

/**
 * Percent as typed, to basis points, **without ever constructing a float**.
 *
 * `Number('12.5') * 100` is 1250.0000000000002 on some inputs and the error is
 * inherited by every amount the rate later multiplies. ADR 0002 bans that for
 * money; a rate is one multiplication away from money, so the same rule applies
 * one step early.
 *
 * So the arithmetic is done on the digits: split at the point, pad the fraction
 * to exactly two places, and concatenate. "12.5" becomes "12" + "50" = 1250.
 * The result is an integer by construction rather than by rounding.
 */
function basisPointsFromPercent(text: string): number | null {
  // Up to two decimal places, because a basis point *is* one hundredth of a
  // percent — a third decimal is a precision this unit cannot carry, and
  // silently rounding it away would store a rate nobody typed.
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(text)) return null;

  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole + fraction.padEnd(2, '0'));
}

function readRate(raw: string, label: string): { bp: number } | { message: string } {
  const trimmed = raw.trim();

  if (trimmed === '') {
    return { message: `Give the ${label} as a percentage, such as 15.` };
  }

  // Rejected before conversion rather than after, so the message names what was
  // wrong with what they typed instead of reporting a bound they did not breach.
  if (trimmed.endsWith('%')) {
    return {
      message: `${label}: give the number only, without the % sign — such as 15.`,
    };
  }

  const bp = basisPointsFromPercent(trimmed);
  if (bp === null) {
    return {
      message:
        `${label} must be a percentage with at most two decimal places, ` +
        'such as 15 or 12.5.',
    };
  }

  if (bp > MAX_FEE_BASIS_POINTS) {
    return {
      message: `${label} cannot exceed ${String(MAX_FEE_BASIS_POINTS / 100)}%.`,
    };
  }

  return { bp };
}

function readAmount(
  raw: string,
  label: string,
): { amount: number } | { message: string } {
  const trimmed = raw.trim();

  // Empty means "no floor", which is a real configuration rather than a missing
  // answer — a category may legitimately set neither. Distinct from the rates
  // above, where empty is somebody not having decided.
  if (trimmed === '') return { amount: 0 };

  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return {
      message:
        `${label} must be an amount in pounds, such as 10.00 — digits only, ` +
        'no currency symbol and no thousands separator.',
    };
  }

  try {
    return { amount: Money.fromMajor(trimmed, 'GBP').amount };
  } catch (error) {
    return {
      message:
        error instanceof MoneyError
          ? `${label}: ${error.message}`
          : `${label} must be an amount in pounds, such as 10.00.`,
    };
  }
}

/**
 * Reads all four fields, reporting the first problem.
 *
 * The cross-field rule — a fee floor may not exceed the booking floor — is
 * deliberately **not** re-implemented here. `categoryFeePolicySchema` enforces
 * it, the API enforces it again, and a database CHECK enforces it a third time.
 * A fourth copy in the browser would be the one that drifts, and it would drift
 * silently because the other three would keep agreeing with each other.
 */
export function readFeePolicy(fields: {
  readonly ownerCommission: string;
  readonly renterFee: string;
  readonly minimumBookingTotal: string;
  readonly minimumPlatformFee: string;
}): FeePolicyInput {
  const owner = readRate(fields.ownerCommission, 'Owner commission');
  if ('message' in owner) return { ok: false, message: owner.message };

  const renter = readRate(fields.renterFee, 'Renter fee');
  if ('message' in renter) return { ok: false, message: renter.message };

  const bookingFloor = readAmount(fields.minimumBookingTotal, 'Minimum booking total');
  if ('message' in bookingFloor) return { ok: false, message: bookingFloor.message };

  const feeFloor = readAmount(fields.minimumPlatformFee, 'Minimum platform fee');
  if ('message' in feeFloor) return { ok: false, message: feeFloor.message };

  return {
    ok: true,
    value: {
      ownerCommissionBasisPoints: owner.bp,
      renterFeeBasisPoints: renter.bp,
      minimumBookingTotal: { amount: bookingFloor.amount, currency: 'GBP' },
      minimumPlatformFee: { amount: feeFloor.amount, currency: 'GBP' },
    },
  };
}

/**
 * Basis points back to the percentage the form shows, for the reconfigure form
 * to seed itself with.
 *
 * String arithmetic again, and for a reason that is not symmetry: `1250 / 100`
 * is exactly 12.5 in floating point, but `String(12.5)` and `String(15)` differ
 * in whether a decimal point appears, and a field that reads "15" on one
 * category and "15.00" on another looks like a difference in configuration.
 * Trailing zeroes are trimmed so a whole percentage reads as a whole number.
 */
export function percentFromBasisPoints(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, '0');
  return fraction === '00'
    ? String(whole)
    : `${String(whole)}.${fraction.replace(/0$/, '')}`;
}
