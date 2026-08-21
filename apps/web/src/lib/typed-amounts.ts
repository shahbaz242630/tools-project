import { Money, MoneyError } from '@platform/core';

/**
 * Turning what somebody typed into the units the platform stores.
 *
 * **Extracted at the second caller** (slice 5.5a), which is the rule
 * `createInternalTrigger` and `describeLine` were each extracted under. The
 * argument is not line count: the delicate part is `basisPointsFromPercent`
 * avoiding floating point on the digits, and two copies of a subtlety are two
 * chances for one to be edited by somebody who has not read the other. A damage
 * excess is one multiplication away from a card hold, so a rate parsed a
 * slightly different way there than in `fee-policy.ts` is a difference nobody
 * would see until they compared two screens.
 *
 * **The form asks for percentages and pounds; storage wants basis points and
 * pence.** 2.4b's rule about scaled numbers: the client sends what somebody
 * typed and the conversion happens once, server-side, where the scale is known.
 */

/**
 * Percent as typed, to basis points, **without ever constructing a float**.
 *
 * `Number('12.5') * 100` is 1250.0000000000002 on some inputs, and the error is
 * inherited by every amount the rate later multiplies. ADR 0002 bans that for
 * money; a rate is one multiplication away from money, so the same rule applies
 * one step early.
 *
 * So the arithmetic is done on the digits: split at the point, pad the fraction
 * to exactly two places, and concatenate. "12.5" becomes "12" + "50" = 1250. The
 * result is an integer by construction rather than by rounding.
 */
export function basisPointsFromPercent(text: string): number | null {
  // Up to two decimal places, because a basis point *is* one hundredth of a
  // percent — a third decimal is a precision this unit cannot carry, and
  // silently rounding it away would store a rate nobody typed. Up to three
  // whole digits, so 100% is expressible where a policy allows it.
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) return null;

  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole + fraction.padEnd(2, '0'));
}

/**
 * Basis points back to the percentage a form field shows.
 *
 * String arithmetic again, and for a reason that is not symmetry: `1250 / 100`
 * is exactly 12.5 in floating point, but `String(12.5)` and `String(15)` differ
 * in whether a decimal point appears, and a field reading "15" on one category
 * and "15.00" on another looks like a difference in configuration. Trailing
 * zeroes are trimmed so a whole percentage reads as a whole number.
 */
export function percentFromBasisPoints(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, '0');
  return fraction === '00'
    ? String(whole)
    : `${String(whole)}.${fraction.replace(/0$/, '')}`;
}

export type ReadRate = { readonly bp: number } | { readonly message: string };

/**
 * A percentage field, bounded by whatever the calling policy allows.
 *
 * **The maximum is a parameter rather than a constant here**, because the two
 * callers bound differently and for different reasons: a fee is capped at 50% so
 * a typo cannot take half of every booking, and an excess percentage is capped
 * at 100% because a renter cannot owe more than the item is worth. Baking either
 * in would make this function quietly wrong for the other.
 */
export function readRate(
  raw: string,
  label: string,
  maximumBasisPoints: number,
): ReadRate {
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

  if (bp > maximumBasisPoints) {
    return {
      message: `${label} cannot exceed ${String(maximumBasisPoints / 100)}%.`,
    };
  }

  return { bp };
}

export type ReadAmount = { readonly amount: number } | { readonly message: string };

/**
 * A pounds field, to pence.
 *
 * **`whenBlank` is a parameter because blank means different things.** On a fee
 * floor it means "no floor", a real configuration somebody may choose. On a
 * recovery ceiling it means somebody has not answered, and answering is the
 * whole point of the field. A shared default of `0` would have turned the second
 * into the first silently.
 */
export function readAmount(
  raw: string,
  label: string,
  whenBlank: { readonly amount: number } | { readonly message: string },
): ReadAmount {
  const trimmed = raw.trim();

  if (trimmed === '') return whenBlank;

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
