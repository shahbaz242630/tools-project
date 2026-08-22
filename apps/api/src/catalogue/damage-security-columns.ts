import { Money } from '@platform/core';
import type { DamageSecurityPolicy } from '@platform/contracts';

/**
 * BRD §8.7.2's five nullable columns, on the way back out of Postgres.
 *
 * **Its own file because two stores read them from slice 5.5b-i.**
 * `prisma-category-store` reads the band to administer it; `prisma-listing-store`
 * reads it to price the hold a listing page discloses. The mappers beside it —
 * `asFeePolicy`, `asAttributes`, `asTransportOptions` — are duplicated in both
 * stores, and that was tolerable while each was shaping loose JSON under its own
 * error message. This one is different in kind: it **asserts what a database
 * CHECK guarantees**, and a rule with two copies is a rule that gets half fixed.
 *
 * It takes the subject as a parameter rather than the row's identity, so both
 * callers keep the error message their own reader needs.
 */

/**
 * The band, or null where the category requires no damage security.
 *
 * **It reads one column to decide, not all five.** `damage_security_is_complete`
 * makes a partial band unstorable, so any one column answers the question and
 * checking several would be re-implementing the CHECK in a place that cannot
 * enforce it. The column chosen is the ceiling, because it is the one the
 * constraint requires to be positive — so a non-null value there cannot be the
 * zero that `excessFloorAmount` may legitimately hold.
 *
 * **Null means "requires no security", never "not configured"** (ADR 0052), with
 * the cost that on a version written before 5.5a the two read identically.
 */
export function asDamageSecurity(
  version: {
    excessFloorAmount: number | null;
    excessFloorCurrency: string | null;
    excessPercentageBasisPoints: number | null;
    recoveryCeilingAmount: number | null;
    recoveryCeilingCurrency: string | null;
  },
  what: string,
): DamageSecurityPolicy | null {
  if (version.recoveryCeilingAmount === null) {
    return null;
  }

  /*
   * The CHECK guarantees the rest are present, and TypeScript cannot see a
   * CHECK. These assertions state what the database is enforcing rather than
   * re-deriving it — the alternative is four `?? 0` defaults, each of which
   * would turn a constraint violation that cannot happen into a silently wrong
   * band if it ever did.
   */
  if (
    version.excessFloorAmount === null ||
    version.excessFloorCurrency === null ||
    version.excessPercentageBasisPoints === null ||
    version.recoveryCeilingCurrency === null
  ) {
    throw new Error(
      `${what} has a partial damage security band, which damage_security_is_complete should make unstorable`,
    );
  }

  return {
    excessFloor: {
      amount: version.excessFloorAmount,
      currency: asBandCurrency(version.excessFloorCurrency, what),
    },
    excessPercentageBasisPoints: version.excessPercentageBasisPoints,
    recoveryCeiling: {
      amount: version.recoveryCeilingAmount,
      currency: asBandCurrency(version.recoveryCeilingCurrency, what),
    },
  };
}

/**
 * A currency this build can do arithmetic in, or a throw naming the subject.
 *
 * `asFeePolicy`'s treatment and for the same reason, one degree more
 * consequential: a band in an unsupported currency is an amount nothing can hold
 * against a card, and §8.7.1 makes the held amount a hard ceiling on recovery.
 */
function asBandCurrency(value: string, what: string): Money.CurrencyCode {
  if ((Money.SUPPORTED_CURRENCIES as readonly string[]).includes(value)) {
    return value as Money.CurrencyCode;
  }
  throw new Error(
    `${what} has a damage security band in a currency this build cannot do arithmetic in: ${value}`,
  );
}
