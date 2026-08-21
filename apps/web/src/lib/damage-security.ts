import type { DamageSecurityPolicy } from '@platform/contracts';
import {
  MAX_DAMAGE_SECURITY_MINOR_UNITS,
  MAX_EXCESS_PERCENTAGE_BASIS_POINTS,
} from '@platform/contracts';
import { Money } from '@platform/core';
import { percentFromBasisPoints, readAmount, readRate } from './typed-amounts';

/**
 * BRD §8.7.2's excess band as an administrator types it, to the shape the
 * contract stores — or an explicit `null` where the category requires no damage
 * security at all.
 *
 * Beside `fee-policy.ts` and for its reasons: business logic, testable without
 * `next/headers`, and a `'use server'` file cannot be imported by a test.
 */
export type DamageSecurityInput =
  | { readonly ok: true; readonly value: DamageSecurityPolicy | null }
  | { readonly ok: false; readonly message: string };

/**
 * What the radio group posts. Neither value is a default — the form ships both
 * unchecked, so an unanswered question arrives here as `undefined` rather than
 * as a decision nobody made (ADR 0052).
 */
export const DAMAGE_SECURITY_REQUIRED = 'required';
export const DAMAGE_SECURITY_NONE = 'none';

/**
 * Reads the choice and, where one is required, the three values behind it.
 *
 * **An absent choice is an error and not a `null`**, which is the whole reason
 * this returns a discriminated result rather than a policy. §8.7.2 permits a
 * category to require no security, so `null` has to be sayable — but a caller
 * who said nothing has not said that, and treating silence as "no security"
 * would configure exactly the outcome §8.7.2 prohibits doing silently.
 *
 * The cross-field rule — the floor may not exceed the ceiling — is deliberately
 * **not** re-implemented here, for `readFeePolicy`'s reason:
 * `damageSecurityPolicySchema` enforces it, the API enforces it again, and
 * `damage_security_is_complete` enforces it a third time. A fourth copy in the
 * browser would be the one that drifts, silently, because the other three would
 * go on agreeing with each other.
 */
export function readDamageSecurity(fields: {
  readonly choice: string | undefined;
  readonly excessFloor: string;
  readonly excessPercentage: string;
  readonly recoveryCeiling: string;
}): DamageSecurityInput {
  if (fields.choice === DAMAGE_SECURITY_NONE) {
    return { ok: true, value: null };
  }

  if (fields.choice !== DAMAGE_SECURITY_REQUIRED) {
    return {
      ok: false,
      message:
        'Say whether this category requires damage security. There is no default — ' +
        'an item handed over with nothing held against it has to be a decision.',
    };
  }

  /*
   * Blank is "no fixed minimum", which §8.7.2 permits: a band may be sized
   * entirely from the percentage. That is the same treatment the fee floors get,
   * and the opposite of the ceiling below.
   */
  const floor = readAmount(fields.excessFloor, 'Excess floor', { amount: 0 });
  if ('message' in floor) return { ok: false, message: floor.message };

  const percentage = readRate(
    fields.excessPercentage,
    'Excess percentage',
    MAX_EXCESS_PERCENTAGE_BASIS_POINTS,
  );
  if ('message' in percentage) return { ok: false, message: percentage.message };

  /*
   * **Blank is a missing answer here, not a zero**, and the asymmetry with the
   * floor above is the point. A ceiling of nothing is a band from which nothing
   * is ever recoverable — which is the no-security case, and the caller has
   * already said this category is not that. Defaulting it to zero would let the
   * two answers contradict each other in one submission.
   */
  const ceiling = readAmount(fields.recoveryCeiling, 'Recovery ceiling', {
    message:
      'Give a recovery ceiling — the most that can ever be recovered from a renter ' +
      'on one booking. For no security at all, choose that above instead.',
  });
  if ('message' in ceiling) return { ok: false, message: ceiling.message };

  if (ceiling.amount > MAX_DAMAGE_SECURITY_MINOR_UNITS) {
    return {
      ok: false,
      message: `Recovery ceiling cannot exceed £${String(
        MAX_DAMAGE_SECURITY_MINOR_UNITS / 100,
      )}.`,
    };
  }

  return {
    ok: true,
    value: {
      excessFloor: { amount: floor.amount, currency: 'GBP' },
      excessPercentageBasisPoints: percentage.bp,
      recoveryCeiling: { amount: ceiling.amount, currency: 'GBP' },
    },
  };
}

/**
 * The band as one line on the admin category list, or its absence (§8.7.2).
 *
 * **Here rather than in the page, so it can be tested** — 5.2d's argument for
 * moving `describeLine` out of `request-panel.tsx`. It is a display helper in a
 * file otherwise about reading a form, and that is deliberate: it is the same
 * concern seen from the other side, and a third file holding one function would
 * be worse than the slight mixing.
 *
 * **"No damage security" is the state this exists to surface.** From 5.5c it
 * means every item in the category is handed to a stranger with nothing held
 * against it — and it is what every category written before this slice reads as,
 * so a list that omitted it would show a catalogue of unsecured categories
 * looking exactly like configured ones. 2.4c-i's finding: configuration
 * invisible in the list is configuration nobody checks.
 */
export function securitySummary(policy: DamageSecurityPolicy | null): string {
  if (policy === null) return 'no damage security';

  const floor = Money.toMajorString(
    Money.money(policy.excessFloor.amount, policy.excessFloor.currency),
  );
  const percentage = percentFromBasisPoints(policy.excessPercentageBasisPoints);
  const ceiling = Money.toMajorString(
    Money.money(policy.recoveryCeiling.amount, policy.recoveryCeiling.currency),
  );

  return `excess £${floor} or ${percentage}%, up to £${ceiling}`;
}
