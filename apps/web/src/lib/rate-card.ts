import { Money, MoneyError } from '@platform/core';
import type { ListingRateCard } from '@platform/contracts';

/**
 * The rate card as an owner types it, to the shape the contract stores.
 *
 * Beside `replacement-value.ts` and `fee-policy.ts`, for their reasons: business
 * logic, testable without `next/headers`, and a `'use server'` file cannot be
 * imported by a test.
 *
 * **Blank is a real answer here, unlike the replacement value.** §8.3 lets an
 * owner save progress, so an unpriced draft is legitimate and every rate is
 * allowed to be absent. What is refused is a rate that was typed and cannot be
 * read — dropping that would throw away a number somebody entered with nothing
 * reporting a problem, which is the failure this whole layer exists to prevent.
 */
export type RateCardInput =
  | { readonly ok: true; readonly value: ListingRateCard }
  | { readonly ok: false; readonly message: string };

/**
 * Pounds as typed, to pence as stored, or null for a rate not given.
 *
 * The value is a string from the browser to `Money.fromMajor` and no further.
 * `parseFloat` is banned (ADR 0002), and this number is multiplied by a fee rate
 * and shown to a stranger as what they will pay.
 */
function readRate(
  raw: string,
  label: string,
): { rate: { amount: number; currency: 'GBP' } | null } | { message: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { rate: null };

  // Refused here rather than by `fromMajor`, which would read "1,299" as 1 —
  // a value a hundredfold too small, on a field that decides what somebody pays.
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return {
      message:
        `${label} must be an amount in pounds, such as 18.00 — digits only, ` +
        'no currency symbol and no thousands separator.',
    };
  }

  try {
    const money = Money.fromMajor(trimmed, 'GBP');
    return { rate: { amount: money.amount, currency: 'GBP' } };
  } catch (error) {
    return {
      message:
        error instanceof MoneyError
          ? `${label}: ${error.message}`
          : `${label} must be an amount in pounds, such as 18.00.`,
    };
  }
}

/**
 * Reads all three rates, reporting the first problem.
 *
 * **The "a daily rate is needed first" rule is deliberately not repeated here.**
 * `listingRateCardSchema` enforces it, the API enforces it again, and a database
 * CHECK enforces it a third time. A fourth copy in the browser would be the one
 * that drifts, and it would drift silently because the other three would go on
 * agreeing with each other.
 */
export function readRateCard(fields: {
  readonly daily: string;
  readonly weekend: string;
  readonly weekly: string;
}): RateCardInput {
  const daily = readRate(fields.daily, 'Daily rate');
  if ('message' in daily) return { ok: false, message: daily.message };

  const weekend = readRate(fields.weekend, 'Weekend rate');
  if ('message' in weekend) return { ok: false, message: weekend.message };

  const weekly = readRate(fields.weekly, 'Weekly rate');
  if ('message' in weekly) return { ok: false, message: weekly.message };

  return {
    ok: true,
    value: { daily: daily.rate, weekend: weekend.rate, weekly: weekly.rate },
  };
}

/** Pence back to the pounds a form field shows. Blank for a rate not set. */
export function poundsOrBlank(rate: { readonly amount: number } | null): string {
  return rate === null ? '' : Money.toMajorString(Money.money(rate.amount, 'GBP'));
}
