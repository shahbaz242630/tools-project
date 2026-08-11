'use client';

import { useState } from 'react';
import {
  RECOMMENDED_OWNER_COMMISSION_BASIS_POINTS,
  RECOMMENDED_RENTER_FEE_BASIS_POINTS,
  isFeePolicyConfigured,
} from '@platform/contracts';
import type { CategoryFeePolicy } from '@platform/contracts';
import { Money } from '@platform/core';
import { percentFromBasisPoints } from '../lib/fee-policy';

/**
 * What the platform charges on a booking in this category (BRD §8.2, §3.4).
 *
 * **Four ordinary named inputs, not the hidden-JSON shape the attribute and
 * transport editors use.** Those two serialise because they are variable-length
 * and structured, and indexed field names would need a server-side reassembler
 * that duplicates the contract. A fee policy is four fixed values, so plain
 * fields are the honest encoding — and they keep working with the browser's own
 * validation, which a JSON blob does not.
 *
 * **The fields ask for percentages.** Basis points are how the platform stores a
 * rate and nobody thinks in them; an administrator asked for basis points
 * eventually types 15 and configures a category at 0.15%. The conversion happens
 * once, server-side, in `readFeePolicy` — which is 2.4b's rule about scaled
 * numbers applied to a second field.
 */

function band(range: { readonly minimum: number; readonly maximum: number }): string {
  return `${percentFromBasisPoints(range.minimum)}–${percentFromBasisPoints(range.maximum)}%`;
}

/** Pence to the pounds the field shows. Empty for no floor, which is a real setting. */
function poundsOrBlank(amount: number): string {
  return amount === 0 ? '' : Money.toMajorString(Money.money(amount, 'GBP'));
}

export function FeePolicyEditor({
  idPrefix,
  initial,
}: {
  readonly idPrefix: string;
  /** Seeded on reconfigure, because `PUT` replaces the whole configuration. */
  readonly initial?: CategoryFeePolicy;
}) {
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  /**
   * **An unpriced category seeds blank fields rather than zeroes.**
   *
   * Its stored rates *are* zero — that is the default every category created
   * before slice 2.7a carries — but rendering "0" would present a value nobody
   * chose as one somebody did, and the fields are `required`, so a blank forces
   * the rate to be decided before the category can be saved again. A default
   * shown as an answer is how a category ends up earning the platform nothing
   * because somebody pressed Save.
   *
   * The cost is that a category deliberately priced at 0% also seeds blank and
   * has to have the zero retyped. That is the right way round: 0% is unusual
   * enough to be worth reconfirming, and `isFeePolicyConfigured` cannot tell the
   * two apart because in the data they are the same row.
   */
  const priced = initial !== undefined && isFeePolicyConfigured(initial);

  /**
   * **Controlled, not `defaultValue`, and the difference is a refused save.**
   *
   * React 19 resets the form once a server action settles. A reset restores each
   * input from its *attribute*, so a `defaultValue` of `''` — which is what an
   * unpriced category renders — puts all four fields back to empty. An
   * administrator who typed four numbers and got told one of them was wrong
   * would lose the other three, and the next Save would fail differently,
   * complaining the required rates are missing. That is the third variant of the
   * same React 19 defect: 2.4c-i found it on checkboxes, 2.5a on selects, and
   * this is the text-input case the earlier note said was safe.
   *
   * It *is* safe when the value round-trips through the action state, as `slug`
   * and `reason` do. Holding it in React state here is the same fix for a
   * component that owns four fields nobody else needs to know about, and it is
   * how the attribute and transport editors already survive a refusal.
   */
  const [ownerCommission, setOwnerCommission] = useState(
    priced ? percentFromBasisPoints(initial.ownerCommissionBasisPoints) : '',
  );
  const [renterFee, setRenterFee] = useState(
    priced ? percentFromBasisPoints(initial.renterFeeBasisPoints) : '',
  );
  const [minimumBookingTotal, setMinimumBookingTotal] = useState(
    priced ? poundsOrBlank(initial.minimumBookingTotal.amount) : '',
  );
  const [minimumPlatformFee, setMinimumPlatformFee] = useState(
    priced ? poundsOrBlank(initial.minimumPlatformFee.amount) : '',
  );

  return (
    <fieldset>
      <legend>Fees</legend>

      {/*
        **Rewritten in slice 2.7c, because the sentence here was true and
        misleading** (ADR 0042). It said a change never re-prices an existing
        *booking* — still true, and it invited the obvious inference that nothing
        else moves either. Changing a rate now re-prices **every existing listing
        in the category, immediately**, because a listing shows the price payable
        today (§3.4.4) rather than the terms it was written under.

        An administrator about to change a percentage is the one person who has to
        know that, and this help text is the only place they will be told. The
        warning is deliberately not softened into "may affect": it affects all of
        them, on save, with nobody notified.
      */}
      <p>What the platform takes on every booking in this category.</p>

      <p>
        <strong>
          Changing a rate re-prices every listing in this category straight away.
        </strong>{' '}
        Owners are not told, and there is no email yet — they will simply see a
        different total the next time they look. What owners set themselves, their own
        rate, is never touched.
      </p>

      <p>
        <strong>Bookings already made are not affected.</strong> A booking keeps the
        rates that were in force when it was made, and no change here can reach one.
      </p>

      <p>
        <label htmlFor={id('owner-commission')}>Owner commission (%)</label>
        <input
          id={id('owner-commission')}
          name="ownerCommission"
          type="text"
          inputMode="decimal"
          required
          value={ownerCommission}
          onChange={(event) => {
            setOwnerCommission(event.target.value);
          }}
          aria-describedby={id('owner-commission-help')}
          placeholder="15"
        />
      </p>
      <p id={id('owner-commission-help')}>
        Deducted from what the owner is paid. Recommended{' '}
        {band(RECOMMENDED_OWNER_COMMISSION_BASIS_POINTS)} — guidance, not a limit.
      </p>

      <p>
        <label htmlFor={id('renter-fee')}>Renter fee (%)</label>
        <input
          id={id('renter-fee')}
          name="renterFee"
          type="text"
          inputMode="decimal"
          required
          value={renterFee}
          onChange={(event) => {
            setRenterFee(event.target.value);
          }}
          aria-describedby={id('renter-fee-help')}
          placeholder="8"
        />
      </p>
      <p id={id('renter-fee-help')}>
        Added to what the renter pays, and{' '}
        <strong>included in every price shown</strong> — search results, listing cards
        and listing pages all display a total inclusive of it. Recommended{' '}
        {band(RECOMMENDED_RENTER_FEE_BASIS_POINTS)} — guidance, not a limit.
      </p>

      <p>
        <label htmlFor={id('minimum-booking-total')}>Minimum booking total (£)</label>
        <input
          id={id('minimum-booking-total')}
          name="minimumBookingTotal"
          type="text"
          inputMode="decimal"
          value={minimumBookingTotal}
          onChange={(event) => {
            setMinimumBookingTotal(event.target.value);
          }}
          aria-describedby={id('minimum-booking-total-help')}
          placeholder="10.00"
        />
      </p>
      <p id={id('minimum-booking-total-help')}>
        Bookings below this cannot be submitted. Leave blank for no minimum. On a small
        enough booking the fixed card and payout costs exceed the percentage entirely.
      </p>

      <p>
        <label htmlFor={id('minimum-platform-fee')}>Minimum platform fee (£)</label>
        <input
          id={id('minimum-platform-fee')}
          name="minimumPlatformFee"
          type="text"
          inputMode="decimal"
          value={minimumPlatformFee}
          onChange={(event) => {
            setMinimumPlatformFee(event.target.value);
          }}
          aria-describedby={id('minimum-platform-fee-help')}
          placeholder="1.00"
        />
      </p>
      <p id={id('minimum-platform-fee-help')}>
        Charged when the percentage would fall below it. Leave blank for none.{' '}
        <strong>Cannot be more than the minimum booking total</strong> — otherwise the
        smallest permitted booking would owe the platform more than it is worth, so the
        two have to be decided together.
      </p>
    </fieldset>
  );
}
