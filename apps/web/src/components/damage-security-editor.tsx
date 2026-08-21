'use client';

import { useState } from 'react';
import type { DamageSecurityPolicy } from '@platform/contracts';
import { Money } from '@platform/core';
import { percentFromBasisPoints } from '../lib/typed-amounts';
import { DAMAGE_SECURITY_NONE, DAMAGE_SECURITY_REQUIRED } from '../lib/damage-security';

/**
 * BRD §8.7.2's excess band, or a declaration that the category needs none.
 *
 * **The choice is a required radio group with neither option pre-selected**, and
 * that is the part of ADR 0052 this component exists to implement. The database
 * cannot tell "nobody configured a band" from "we chose to require none" — both
 * are five nulls — so the deliberateness has to live at the moment of authoring.
 * A checkbox defaulting to either answer would make the commonest outcome the
 * one nobody chose.
 *
 * **The cost, stated because an administrator will meet it:** a category that
 * currently has no band seeds no answer, so the question is asked again on every
 * reconfiguration. That is the right side of the trade — the alternative is
 * pre-selecting "requires none" for exactly the rows we cannot vouch for, which
 * is the fee editor's argument about seeding blank rather than zero, on a field
 * where the consequence is an unsecured handover rather than a lost margin.
 *
 * Four ordinary named inputs like `FeePolicyEditor`, not the hidden-JSON shape
 * the attribute and transport editors use: this is a fixed set of values, so
 * plain fields are the honest encoding and the browser's own validation keeps
 * working.
 */

/** Pence to the pounds the field shows. Blank for zero, which is a real setting. */
function poundsOrBlank(amount: number): string {
  return amount === 0 ? '' : Money.toMajorString(Money.money(amount, 'GBP'));
}

export function DamageSecurityEditor({
  idPrefix,
  initial,
}: {
  readonly idPrefix: string;
  /**
   * Seeded on reconfigure, because `PUT` replaces the whole configuration.
   *
   * `undefined` is a category being created; `null` is one that exists and
   * carries no band. **Both seed an unanswered question** — see the note above.
   */
  readonly initial?: DamageSecurityPolicy | null;
}) {
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  const banded = initial !== undefined && initial !== null;

  /*
   * Controlled, not `defaultValue` or `defaultChecked`, and the difference is a
   * refused save. React 19 resets the form once a server action settles, and a
   * reset restores each input from its *attribute* — so an administrator who
   * typed three numbers and got told one was wrong would lose the other two and
   * the radio with them. That is the same React 19 defect 2.4c-i found on
   * checkboxes and 2.5a on selects, and `FeePolicyEditor` already carries the
   * text-input case.
   */
  const [choice, setChoice] = useState(banded ? DAMAGE_SECURITY_REQUIRED : '');
  const [excessFloor, setExcessFloor] = useState(
    banded ? poundsOrBlank(initial.excessFloor.amount) : '',
  );
  const [excessPercentage, setExcessPercentage] = useState(
    banded ? percentFromBasisPoints(initial.excessPercentageBasisPoints) : '',
  );
  const [recoveryCeiling, setRecoveryCeiling] = useState(
    banded ? poundsOrBlank(initial.recoveryCeiling.amount) : '',
  );

  return (
    <fieldset>
      <legend>Damage security</legend>

      <p>
        How much of a loss a renter bears if an item comes back damaged, and the most
        that can ever be recovered from them.
      </p>

      <p>
        <strong>Nothing is held when a booking is made.</strong> The hold is taken when
        the collection window opens, and the amount held is a hard ceiling — whatever is
        not held cannot be recovered from the card afterwards.
      </p>

      <p>
        <strong>Bookings already made are not affected.</strong> A booking keeps the
        band that was in force when it was made, and no change here can reach one.
      </p>

      {/*
        A radio group rather than a checkbox, so that "requires none" is something
        somebody says rather than something they leave. `required` on both inputs
        makes the browser refuse a submission with neither chosen, which is the
        client-side half of the same rule `readDamageSecurity` enforces server-side.
      */}
      <fieldset>
        <legend>Does this category require damage security?</legend>

        <p>
          <input
            id={id('damage-security-required')}
            name="damageSecurityChoice"
            type="radio"
            required
            value={DAMAGE_SECURITY_REQUIRED}
            checked={choice === DAMAGE_SECURITY_REQUIRED}
            onChange={() => {
              setChoice(DAMAGE_SECURITY_REQUIRED);
            }}
          />
          <label htmlFor={id('damage-security-required')}>
            Yes — hold an excess against the renter&rsquo;s card at collection
          </label>
        </p>

        <p>
          <input
            id={id('damage-security-none')}
            name="damageSecurityChoice"
            type="radio"
            required
            value={DAMAGE_SECURITY_NONE}
            checked={choice === DAMAGE_SECURITY_NONE}
            onChange={() => {
              setChoice(DAMAGE_SECURITY_NONE);
            }}
          />
          <label htmlFor={id('damage-security-none')}>
            No — items in this category are handed over with nothing held
          </label>
        </p>
      </fieldset>

      {/*
        Unmounted rather than hidden when no security is required. A hidden
        `required` field cannot be filled in and blocks submission with a message
        no user can act on — and an unmounted field is not posted at all, which is
        what makes the "no security" branch of `readDamageSecurity` reachable.
      */}
      {choice === DAMAGE_SECURITY_REQUIRED && (
        <>
          <p>
            <label htmlFor={id('excess-floor')}>Excess floor (£)</label>
            <input
              id={id('excess-floor')}
              name="excessFloor"
              type="text"
              inputMode="decimal"
              value={excessFloor}
              onChange={(event) => {
                setExcessFloor(event.target.value);
              }}
              aria-describedby={id('excess-floor-help')}
              placeholder="75.00"
            />
          </p>
          <p id={id('excess-floor-help')}>
            The least a renter ever bears, whatever the item is worth. Leave blank for
            none. It exists to stop small claims costing more to settle than they are
            worth.
          </p>

          <p>
            <label htmlFor={id('excess-percentage')}>Excess percentage (%)</label>
            <input
              id={id('excess-percentage')}
              name="excessPercentage"
              type="text"
              inputMode="decimal"
              required
              value={excessPercentage}
              onChange={(event) => {
                setExcessPercentage(event.target.value);
              }}
              aria-describedby={id('excess-percentage-help')}
              placeholder="15"
            />
          </p>
          <p id={id('excess-percentage-help')}>
            A share of what each listing says it would cost to replace.{' '}
            <strong>The renter bears whichever is larger</strong> — this or the floor
            above. It is what lets one setting cover a £40 sander and a £900 breaker.
          </p>

          <p>
            <label htmlFor={id('recovery-ceiling')}>Recovery ceiling (£)</label>
            <input
              id={id('recovery-ceiling')}
              name="recoveryCeiling"
              type="text"
              inputMode="decimal"
              required
              value={recoveryCeiling}
              onChange={(event) => {
                setRecoveryCeiling(event.target.value);
              }}
              aria-describedby={id('recovery-ceiling-help')}
              placeholder="500.00"
            />
          </p>
          <p id={id('recovery-ceiling-help')}>
            The most that can ever be recovered from a renter on one booking, and{' '}
            <strong>it caps the two figures above</strong>. Anything lost beyond it
            falls on the owner, so it is the number that decides how much risk an owner
            carries here. <strong>Cannot be less than the excess floor</strong> —
            otherwise a renter would always owe more than could ever be taken.
          </p>
        </>
      )}
    </fieldset>
  );
}
