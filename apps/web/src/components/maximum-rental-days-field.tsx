import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  MAXIMUM_RENTAL_DAYS_WARNING,
  MAX_MAXIMUM_RENTAL_DAYS,
  MIN_MAXIMUM_RENTAL_DAYS,
} from '@platform/contracts';
import styles from './maximum-rental-days-field.module.css';

/**
 * The longest hire a category permits (BRD §8.5.3, slice 4.4a).
 *
 * **Its own component rather than a field inside `FeePolicyEditor`**, and the
 * distinction is the point: everything in that editor is a commercial number
 * somebody may tune, and this is a legal boundary. Putting them together would
 * make this look like one more lever in the pricing panel.
 *
 * **§8.5.3 requires the interface to warn on change**, and the warning is
 * rendered here, from the constant in `@platform/contracts` — so the sentence is
 * the same on every surface that ever edits this, and a second surface cannot
 * ship without it by forgetting to copy a paragraph.
 *
 * **It is a warning and not a tick box**, deliberately. §8.14.2's reporting flag
 * requires an explicit acknowledgement because it changes our regulatory status
 * on the platform's own account; this one bounds what may be arranged and is
 * enforced by a `CHECK`, the contract and `refusePeriod`. Adding a second
 * mandatory confirmation would dilute the one that exists — the fastest way to
 * make an administrator click through a warning is to give them two.
 */
export function MaximumRentalDaysField({
  idPrefix,
  initial,
}: {
  readonly idPrefix: string;
  /** The category's current cap, or absent when creating one. */
  readonly initial?: number;
}) {
  const id = `${idPrefix}-maximum-rental-days`;

  return (
    <div className={styles.field}>
      <p>
        <label htmlFor={id}>Longest hire (days)</label>
        <input
          id={id}
          name="maximumRentalDays"
          type="number"
          required
          min={MIN_MAXIMUM_RENTAL_DAYS}
          max={MAX_MAXIMUM_RENTAL_DAYS}
          step={1}
          /*
            **Seeded with 88 when creating, unlike the fee editor beside it.**
            That one starts blank on purpose — an unpriced category has no rates
            and a zero would be a number nobody chose. Here there is a right
            answer and §8.5.3 states it, so a blank field would invite somebody
            to invent one. The value is still submitted explicitly rather than
            defaulted server-side, so what is stored is what was on screen.
          */
          defaultValue={initial ?? DEFAULT_MAXIMUM_RENTAL_DAYS}
          aria-describedby={`${id}-help`}
        />
      </p>
      <p id={`${id}-help`} className={styles.warning} role="note">
        <strong>{MAXIMUM_RENTAL_DAYS_WARNING}</strong> The cap applies to the whole hire
        including any extensions, and {String(MAX_MAXIMUM_RENTAL_DAYS)} days is the most
        this platform will accept. Shorter is always safe.
      </p>
    </div>
  );
}
