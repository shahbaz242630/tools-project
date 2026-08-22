import { Money } from '@platform/core';
import { EXCESS_BOUNDS } from '@platform/contracts';
import type { AppliedExcess, ExcessBound } from '@platform/contracts';

/**
 * §8.7.2's applied excess as two nullable columns, both ways (slice 5.5b-ii).
 *
 * **Its own file because `quotes` and `bookings` store it identically**, which
 * is not a coincidence: the booking copies the quote's figure verbatim, so the
 * two columns mean exactly the same thing on both tables and a second reading of
 * them is a second chance to disagree. The catalogue module made the same call
 * one slice earlier with `damage-security-columns.ts`.
 *
 * **The currency is a parameter rather than a column.** Both tables carry one
 * `currency` shared by the item charge, the fee and the total (ADR 0002), and
 * the excess is denominated in it — so an excess in a currency the price is not
 * in is unrepresentable rather than merely refused.
 */

/**
 * The pair, on the way out of Postgres — or null where nothing is held.
 *
 * **It reads the amount to decide, and then insists on the bound.**
 * `quote_damage_excess_is_complete` makes the half-filled pair unstorable, so
 * one column answers the question; the throw below is for a row written around
 * the CHECK rather than through it. `?? 'floor'` would be the alternative and it
 * would invent an explanation for somebody's money.
 *
 * **Zero is a figure, not an absence.** A band with a zero floor against a
 * nearly worthless item rounds to nothing, and a £0 hold is a different fact
 * from a category that requires no security at all (ADR 0052) — so the branch is
 * on `null`, never on falsiness.
 */
export function toAppliedExcess(
  row: {
    readonly damageExcessAmount: number | null;
    readonly damageExcessBoundBy: string | null;
    readonly currency: string;
  },
  what: string,
): AppliedExcess | null {
  if (row.damageExcessAmount === null) return null;

  if (row.damageExcessBoundBy === null) {
    throw new Error(
      `${what} has a damage excess amount with no bound, which damage_excess_is_complete should make unstorable`,
    );
  }

  return {
    amount: Money.money(row.damageExcessAmount, asCurrency(row.currency, what)),
    boundBy: asBound(row.damageExcessBoundBy, what),
  };
}

/**
 * The pair, on the way in. `null` writes two nulls rather than a zero.
 *
 * The currency is deliberately **not** returned: the caller already writes
 * `currency` from the total, and a second expression of it here is how a row
 * comes to hold a hold in one currency and a price in another.
 */
export function damageExcessColumns(excess: AppliedExcess | null): {
  damageExcessAmount: number | null;
  damageExcessBoundBy: string | null;
} {
  return {
    damageExcessAmount: excess === null ? null : excess.amount.amount,
    damageExcessBoundBy: excess === null ? null : excess.boundBy,
  };
}

/**
 * A bound this build understands.
 *
 * The CHECK holds the same vocabulary, so this is unreachable through the
 * product — and it is here for the reason the CHECK is there at all: these rows
 * outlive the code that wrote them, and a bound from a later build reaching an
 * earlier one must fail loudly rather than render as something it is not.
 */
function asBound(value: string, what: string): ExcessBound {
  if ((EXCESS_BOUNDS as readonly string[]).includes(value)) {
    return value as ExcessBound;
  }
  throw new Error(
    `${what} has a damage excess bound this build does not know: ${value}`,
  );
}

function asCurrency(value: string, what: string): Money.CurrencyCode {
  if ((Money.SUPPORTED_CURRENCIES as readonly string[]).includes(value)) {
    return value as Money.CurrencyCode;
  }
  throw new Error(
    `${what} holds a damage excess in a currency this build cannot do arithmetic in: ${value}`,
  );
}
