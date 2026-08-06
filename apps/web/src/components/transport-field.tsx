'use client';

import {
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
  suggestTransportRequirement,
} from '@platform/contracts';
import { ResetSafeSelect } from './reset-safe-select';
import type {
  CategoryTransportOption,
  ItemWeight,
  TransportRequirement,
} from '@platform/contracts';

/**
 * How the renter will have to collect this item (BRD §8.3).
 *
 * **The options come from the category, so this file names none of them.** Which
 * of the platform's five a category offers is versioned configuration
 * (ADR 0031) — a category of hand tools should never invite somebody to say
 * "trailer" — and the same argument as `attribute-fields.tsx`: adding a category
 * changes configuration, not this component.
 *
 * §8.3's reason for existing is worth keeping in view while reading this. The
 * renter drives to a stranger's house, so an item that will not fit their car is
 * a failed handover, a dispute and two unhappy people. This is the field that
 * prevents it, which is why the wording is about *their* car and not about
 * categories.
 */

/**
 * What the weight suggests, and whether the owner has overruled it.
 *
 * Two pieces of state rather than one, because "nobody has chosen" and "somebody
 * chose the same thing the suggestion would have" are different: the first must
 * keep following the weight as it is typed, and the second must not. Collapsing
 * them into a single "current value" makes the suggestion fight the owner —
 * every keystroke in the weight box would drag the answer back.
 */
export function TransportField({
  options,
  weight,
  chosen,
  onChange,
  requiresTwoPersonLift,
  onLiftChange,
  idPrefix = 'listing-transport',
}: {
  readonly options: readonly CategoryTransportOption[];
  /** The weight the owner has typed, if the category captures one. */
  readonly weight: ItemWeight | null;
  /** What the owner has chosen, or null while they have not. */
  readonly chosen: TransportRequirement | null;
  readonly onChange: (requirement: TransportRequirement | null) => void;
  readonly requiresTwoPersonLift: boolean;
  readonly onLiftChange: (requires: boolean) => void;
  readonly idPrefix?: string;
}) {
  if (options.length === 0) {
    // Nothing to ask, so nothing is rendered — not an empty select, and not a
    // heading with nothing under it. A category that offers no options is a
    // legitimate configuration and is what every category had before slice
    // 2.4c-i.
    return null;
  }

  const suggested = suggestTransportRequirement(options, weight);
  // The owner's choice always wins. The suggestion only fills the gap.
  const value = chosen ?? suggested ?? '';
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <fieldset>
      <legend>Getting it home</legend>

      <p id={id('help')}>
        Whoever rents this has to come and collect it. Saying what that takes is what
        stops somebody arriving in a hatchback for something that needs a van.
      </p>

      <p>
        <label htmlFor={id('requirement')}>What is needed to collect it</label>
        {/*
          `ResetSafeSelect`, not a bare `<select value=…>` — see that component.
          This one is the reason it re-asserts through a ref rather than using
          `defaultValue`: the displayed value moves on its own as the weight is
          typed, so it has to stay genuinely controlled.
        */}
        <ResetSafeSelect
          id={id('requirement')}
          name="transportRequirement"
          value={value}
          describedBy={id('help')}
          onChange={(next) => {
            // The empty option is a real answer — "I have not decided" — and it
            // must clear the choice rather than reapply the suggestion, or the
            // owner could never get back to unanswered.
            onChange(next === '' ? null : (next as TransportRequirement));
          }}
        >
          {/* What "not answered yet" looks like on a draft. Without it the
              select silently answers the question with whichever option happens
              to come first. */}
          <option value="">No answer yet</option>
          {options.map((option) => (
            <option key={option.requirement} value={option.requirement}>
              {TRANSPORT_REQUIREMENT_LABELS[option.requirement]} —{' '}
              {TRANSPORT_REQUIREMENT_HINTS[option.requirement]}
            </option>
          ))}
        </ResetSafeSelect>
      </p>

      {/*
        Said out loud when the answer on screen came from the weight rather than
        from the owner. A field that filled itself in silently is one somebody
        submits without reading — and this one is a promise to a stranger about
        what vehicle to bring.
      */}
      {chosen === null && suggested !== null ? (
        <p role="status">
          Suggested from the weight you entered. Change it if that is wrong — a
          folded-down seat or an awkward shape is something only you can see.
        </p>
      ) : null}

      <p>
        <label htmlFor={id('lift')}>
          {/*
            `defaultChecked` kept in step with state, never `checked`, and never
            left to the DOM alone. React 19 resets the form once a server action
            settles, which un-ticks a checkbox whose value came from a click —
            and here that would quietly discard something the owner stated about
            their own item after a save was refused for an unrelated reason.
            Slice 2.4c-i found this the hard way on the admin form; it is the
            same control in a different place. See `transport-options-editor`.
          */}
          <input
            id={id('lift')}
            name="requiresTwoPersonLift"
            type="checkbox"
            defaultChecked={requiresTwoPersonLift}
            aria-describedby={id('lift-help')}
            onChange={(event) => {
              onLiftChange(event.target.checked);
            }}
          />{' '}
          It takes two people to lift
        </label>
      </p>
      <p id={id('lift-help')}>
        Separate from the vehicle, because it is a different question — something can
        need a van <em>and</em> two people. It goes on the handover checklist so nobody
        turns up alone.
      </p>
    </fieldset>
  );
}
