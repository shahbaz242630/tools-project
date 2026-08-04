/**
 * Money, as it crosses the wire.
 *
 * Its own file rather than a field on the one contract that happens to need it
 * first. Every priced thing in this system — listing values, quotes, fees,
 * deposits, ledger entries, payouts — has to agree about this shape, and the
 * moment two of them disagree the disagreement is in pounds.
 *
 * **The rule this file exists to enforce, from CLAUDE.md and ADR 0002:
 * integer minor units plus an ISO 4217 currency code on the same record.**
 * Floats are banned in the database, in API contracts and in business logic.
 * `1.15` cannot be represented exactly in binary floating point, and the error
 * does not stay small once it is multiplied by a fee rate and split between two
 * parties.
 *
 * `@platform/core` owns the arithmetic; this owns the wire shape. The currency
 * list comes from there — `Money.SUPPORTED_CURRENCIES` — so a currency the
 * platform cannot do arithmetic in cannot be accepted by an endpoint either.
 */

import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { z } from 'zod';

/**
 * An amount, in the currency's minor units.
 *
 * `int()` is doing real work: it rejects `10.5`, which is what a caller sending
 * pounds where pence were meant looks like. Without it, `10.5` pence would be
 * stored, rounded somewhere downstream, and the loss would be discovered by a
 * ledger that stopped balancing rather than by a validation error.
 *
 * Unbounded here, deliberately — sign and magnitude are the caller's business.
 * A refund is negative, and a ledger reversal is the whole point of allowing it.
 * Contracts that need a range say so themselves, as `replacementValueSchema`
 * does below.
 */
export const minorUnitsSchema = z
  .number()
  .int('must be a whole number of pence — money is never fractional pence');

export const currencyCodeSchema = z.enum(Money.SUPPORTED_CURRENCIES);

/**
 * The wire shape: `{ amount, currency }`.
 *
 * The currency travels with the amount rather than being implied by the
 * platform's single supported currency. Today they are the same thing; the day
 * a second currency exists, every record that stored a bare number becomes
 * ambiguous with no way to tell which ones were which.
 */
export const moneySchema = z.object({
  amount: minorUnitsSchema,
  currency: currencyCodeSchema,
});

/**
 * Structurally `Money` from `@platform/core`, and typed as it on purpose.
 *
 * A parsed amount is immediately usable by the arithmetic without a conversion
 * step — and a conversion step is where a `number` would get a chance to become
 * a float.
 */
export type MoneyInput = MoneyValue;

/**
 * A bounded amount, for the fields where an absurd value is a typing error
 * rather than an intention.
 *
 * Both bounds are inclusive and both are stated in minor units by the caller,
 * so the message can name pounds without this function knowing what a pound is
 * worth in any other currency.
 */
export function boundedMoneySchema(options: {
  readonly minimum: number;
  readonly maximum: number;
  readonly minimumLabel: string;
  readonly maximumLabel: string;
}) {
  return moneySchema.superRefine((value, ctx) => {
    if (value.amount < options.minimum) {
      ctx.addIssue({
        code: 'custom',
        message: `must be at least ${options.minimumLabel}`,
        path: ['amount'],
      });
    }
    if (value.amount > options.maximum) {
      ctx.addIssue({
        code: 'custom',
        message: `must be at most ${options.maximumLabel}`,
        path: ['amount'],
      });
    }
  });
}
