import {
  DEFAULT_REQUEST_EXPIRY_HOURS,
  MAX_REQUEST_EXPIRY_HOURS,
  MIN_REQUEST_EXPIRY_HOURS,
} from '@platform/contracts';

/**
 * How long an owner has to answer a request (BRD §8.6, slice 4.5a).
 *
 * **Its own component beside `MaximumRentalDaysField` rather than inside it**, for
 * the reason that one gives about the fee editor: the two are different kinds of
 * number. The cap is a legal boundary and carries a warning §8.5.3 requires; this
 * is an operational choice with nothing but a trade-off behind it, and pairing
 * them would make this look like a second legal limit or that one like a
 * preference.
 *
 * **No warning paragraph, deliberately.** Changing it affects requests made from
 * then on and leaves every existing one reading against the deadline it was made
 * under, which is what versioned configuration already guarantees. There is
 * nothing to caution about, and a warning nobody needs is how the ones that matter
 * stop being read.
 *
 * **Plain text under the field rather than nothing**, because the two directions
 * are not obvious: too short and a private owner with a job misses the request,
 * too long and a renter cannot go and ask somebody else.
 */
export function RequestExpiryField({
  idPrefix,
  initial,
}: {
  readonly idPrefix: string;
  /** What this category allows now, or absent when creating one. */
  readonly initial?: number;
}) {
  const id = `${idPrefix}-request-expiry-hours`;

  return (
    <p>
      <label htmlFor={id}>Time to answer a request (hours)</label>
      <input
        id={id}
        name="requestExpiryHours"
        type="number"
        required
        min={MIN_REQUEST_EXPIRY_HOURS}
        max={MAX_REQUEST_EXPIRY_HOURS}
        step={1}
        /*
          Seeded with 48, like the cap beside it and unlike the fee editor: there
          is a defensible default and a blank field would invite somebody to
          invent one. The value is still submitted explicitly, so what is stored
          is what was on screen.
        */
        defaultValue={initial ?? DEFAULT_REQUEST_EXPIRY_HOURS}
        aria-describedby={`${id}-help`}
      />
      <span id={`${id}-help`}>
        After this, an unanswered request expires on its own. Long enough that an owner
        with a job does not miss it — {String(DEFAULT_REQUEST_EXPIRY_HOURS)} hours
        covers a weekend — and short enough that a renter is not left waiting.
      </span>
    </p>
  );
}
