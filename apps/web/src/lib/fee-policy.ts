import type { CategoryFeePolicy } from '@platform/contracts';
import { MAX_FEE_BASIS_POINTS } from '@platform/contracts';
import { readAmount, readRate } from './typed-amounts';

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
 *
 * **The conversions themselves moved to `typed-amounts.ts` in slice 5.5a**, when
 * the damage-security band became a second caller. They were never fee-specific;
 * they were only ever in this file because it was the first to need them.
 */
export type FeePolicyInput =
  | { readonly ok: true; readonly value: CategoryFeePolicy }
  | { readonly ok: false; readonly message: string };

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
  const owner = readRate(
    fields.ownerCommission,
    'Owner commission',
    MAX_FEE_BASIS_POINTS,
  );
  if ('message' in owner) return { ok: false, message: owner.message };

  const renter = readRate(fields.renterFee, 'Renter fee', MAX_FEE_BASIS_POINTS);
  if ('message' in renter) return { ok: false, message: renter.message };

  /*
   * Empty means "no floor", which is a real configuration rather than a missing
   * answer — a category may legitimately set neither. Distinct from the rates
   * above, where empty is somebody not having decided.
   */
  const bookingFloor = readAmount(fields.minimumBookingTotal, 'Minimum booking total', {
    amount: 0,
  });
  if ('message' in bookingFloor) return { ok: false, message: bookingFloor.message };

  const feeFloor = readAmount(fields.minimumPlatformFee, 'Minimum platform fee', {
    amount: 0,
  });
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

export { percentFromBasisPoints } from './typed-amounts';
