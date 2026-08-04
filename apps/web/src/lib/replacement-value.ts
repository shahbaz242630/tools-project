import { Money, MoneyError } from '@platform/core';
import type { MoneyValue } from '@platform/core';

/**
 * Pounds as typed, to pence as stored.
 *
 * Its own module rather than a helper inside the server action, because this is
 * the one piece of money logic in the web app and a `'use server'` file cannot
 * be imported by a test without dragging in `next/headers` and Clerk. Business
 * logic does not belong in a route handler anyway (CLAUDE.md).
 *
 * **The value is a string from the browser to here and no further.**
 * `Money.fromMajor` takes a string precisely so that no float ever exists:
 * `parseFloat` is banned (ADR 0002), and `24.99` has no exact binary
 * representation. §8.7.1 turns this number into a damage excess held on
 * somebody's card, so a rounding error here is somebody's money.
 */
export type ReplacementValue =
  | { readonly ok: true; readonly value: MoneyValue }
  | { readonly ok: false; readonly message: string };

export function readReplacementValue(raw: string): ReplacementValue {
  const trimmed = raw.trim();

  if (trimmed === '') {
    return { ok: false, message: 'Give what it would cost to replace the item.' };
  }

  // Rejected here rather than by `fromMajor`, which would read "£249" out of
  // "£249" and silently accept a currency symbol we never asked for — and would
  // read "1,299" as "1" on the way to a value a hundredfold too small.
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return {
      ok: false,
      message:
        'Replacement value must be an amount in pounds, such as 249.99 — digits only, ' +
        'no currency symbol and no thousands separator.',
    };
  }

  try {
    return { ok: true, value: Money.fromMajor(trimmed, 'GBP') };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof MoneyError
          ? `Replacement value: ${error.message}`
          : 'Replacement value must be an amount in pounds, such as 249.99.',
    };
  }
}
