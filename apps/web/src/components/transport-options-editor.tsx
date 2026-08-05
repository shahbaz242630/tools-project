'use client';

import { useState } from 'react';
import {
  MAX_TRANSPORT_SUGGESTION_KG,
  MIN_TRANSPORT_SUGGESTION_KG,
  TRANSPORT_REQUIREMENTS,
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
  WEIGHT_ATTRIBUTE_KEY,
} from '@platform/contracts';
import type {
  CategoryTransportOption,
  TransportRequirement,
} from '@platform/contracts';

/**
 * Which transport requirements this category offers, and up to what weight each
 * one is suggested (§8.3, ADR 0031).
 *
 * **A tick list, not the add-a-row editor the attribute schema uses**, and the
 * difference is the point. An attribute is something an administrator invents:
 * they choose the key, the label and the type, so the control has to let them
 * build one. A transport requirement is chosen from a closed platform
 * vocabulary — five values, fixed, because Phase 3's search filter and Phase 7's
 * handover checklist both have to reason about them. The only decision here is
 * *which of the five apply*, so the control shows all five and asks that.
 *
 * That also removes a whole class of mistake the attribute editor has to guard
 * against: nothing can be spelled wrongly, nothing can be duplicated, and the
 * order is the vocabulary's rather than anything typed here.
 *
 * Like the attribute editor, it serialises into one hidden input rather than
 * indexed field names, and it validates nothing itself — the contract in the
 * server action and again in the API is what decides, and a third opinion in a
 * component is the one that drifts.
 */

/**
 * The threshold is held as the **text in the box**, not as a number.
 *
 * An emptied number input reads as `NaN`, and `JSON.stringify` writes `NaN` as
 * `null` — which is how slice 2.2 nearly shipped a message reading "expected
 * number, received null" about a field somebody had just cleared. Keeping the
 * string means an empty box is unambiguously *no threshold* and never a broken
 * number.
 */
interface OptionDraft {
  readonly offered: boolean;
  readonly upToKg: string;
}

type OptionDrafts = Readonly<Record<TransportRequirement, OptionDraft>>;

function emptyDrafts(): OptionDrafts {
  return Object.fromEntries(
    TRANSPORT_REQUIREMENTS.map((requirement) => [
      requirement,
      { offered: false, upToKg: '' },
    ]),
  ) as OptionDrafts;
}

/** An existing selection, opened for editing. */
function toDrafts(options: readonly CategoryTransportOption[]): OptionDrafts {
  const drafts = { ...emptyDrafts() } as Record<TransportRequirement, OptionDraft>;

  for (const option of options) {
    drafts[option.requirement] = {
      offered: true,
      upToKg:
        option.suggestedUpToKg === undefined ? '' : String(option.suggestedUpToKg),
    };
  }

  return drafts;
}

/**
 * What gets posted, in the vocabulary's own order.
 *
 * The order is not a decision anybody makes here — mapping over
 * `TRANSPORT_REQUIREMENTS` means what leaves this component is already canonical,
 * and the contract's own sort has nothing left to do. An empty box omits the key
 * rather than sending null, so "no threshold" has one representation.
 */
function toOptions(drafts: OptionDrafts): readonly CategoryTransportOption[] {
  return TRANSPORT_REQUIREMENTS.filter(
    (requirement) => drafts[requirement].offered,
  ).map((requirement) => {
    const typed = drafts[requirement].upToKg.trim();
    if (typed === '') return { requirement };

    // A number input hands back "" for anything it cannot read, so this is
    // only reached with digits — but if it ever is not, zero fails the
    // contract with "must be at least 1 kg", which points at the box they
    // just typed in rather than at a type name.
    const kg = Number(typed);
    return { requirement, suggestedUpToKg: Number.isNaN(kg) ? 0 : kg };
  });
}

export function TransportOptionsEditor({
  name,
  initial,
  idPrefix,
}: {
  /** The hidden field the server action reads. */
  readonly name: string;
  readonly initial?: readonly CategoryTransportOption[];
  /** Distinguishes the create form's ids from each category's row form. */
  readonly idPrefix: string;
}) {
  const [drafts, setDrafts] = useState<OptionDrafts>(() => toDrafts(initial ?? []));

  const update = (requirement: TransportRequirement, change: Partial<OptionDraft>) => {
    setDrafts((current) => ({
      ...current,
      [requirement]: { ...current[requirement], ...change },
    }));
  };

  const offered = TRANSPORT_REQUIREMENTS.filter(
    (requirement) => drafts[requirement].offered,
  );

  return (
    <fieldset>
      <legend>Getting it home</legend>

      <p>
        What an owner can say is needed to collect an item in this category. The renter
        drives to their door, so an item that will not fit the car is a failed handover
        — this is the question that prevents it.
      </p>
      <p>
        Tick only what makes sense here. Offering a trailer on a category of hand tools
        asks owners a question with an obviously wrong answer, and offering nothing
        means the question is never asked at all.
      </p>

      {/*
        The serialised value. Rendered whatever the state, including empty, so an
        empty selection posts `[]` rather than an absent field — the server
        refuses an absent one rather than guessing it meant nothing.
      */}
      <input type="hidden" name={name} value={JSON.stringify(toOptions(drafts))} />

      <ol>
        {TRANSPORT_REQUIREMENTS.map((requirement) => {
          const draft = drafts[requirement];
          const id = (field: string) => `${idPrefix}-transport-${requirement}-${field}`;

          return (
            <li key={requirement}>
              <p>
                <label htmlFor={id('offered')}>
                  {/*
                    `defaultChecked`, not `checked`, and this is load-bearing.

                    React 19 **resets the form** once a server action settles.
                    A reset restores every input from its default, and for a
                    checkbox rendered `checked={…}` with no default that means
                    `false` — while React's own state still says the option is
                    offered, and React writes nothing back because the prop did
                    not change. The result is a form that shows five unticked
                    boxes and posts four options, which is the worst kind of
                    wrong: silent, and confidently displayed.

                    Found by ticking four boxes, failing a save on purpose, and
                    looking at the hidden field. Keeping the *default* in step
                    with the state means the reset restores what was ticked.
                    Do not "tidy" this back to `checked` — React will not warn,
                    and nothing fails until somebody's save is refused.

                    Controlled `value` inputs do not have this problem: React
                    re-applies those after a reset. Only checkboxes.
                  */}
                  <input
                    id={id('offered')}
                    type="checkbox"
                    defaultChecked={draft.offered}
                    aria-describedby={id('hint')}
                    onChange={(event) => {
                      update(requirement, { offered: event.target.checked });
                    }}
                  />{' '}
                  {TRANSPORT_REQUIREMENT_LABELS[requirement]}
                </label>
              </p>
              <p id={id('hint')}>{TRANSPORT_REQUIREMENT_HINTS[requirement]}</p>

              {draft.offered ? (
                // Only when the option is offered. A weight box beside an
                // unticked option is a control that cannot affect anything —
                // the same dead control slice 2.1 found on this very page.
                <p>
                  <label htmlFor={id('upto')}>Suggest this up to (kg)</label>
                  <input
                    id={id('upto')}
                    type="number"
                    min={MIN_TRANSPORT_SUGGESTION_KG}
                    max={MAX_TRANSPORT_SUGGESTION_KG}
                    step={1}
                    value={draft.upToKg}
                    placeholder="optional"
                    aria-describedby={id('upto-help')}
                    onChange={(event) => {
                      update(requirement, { upToKg: event.target.value });
                    }}
                  />
                </p>
              ) : null}
              {draft.offered ? (
                <p id={id('upto-help')}>
                  Leave blank to never suggest it. Each option must cover heavier items
                  than the one above it.
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {offered.length === 0 ? (
        <p role="status">
          Nothing ticked, so listings in this category will not be asked how the item is
          collected.
        </p>
      ) : (
        <p>
          Weight suggestions only work if this category has a <strong>number</strong>{' '}
          attribute stored as <code>{WEIGHT_ATTRIBUTE_KEY}</code>. Without one, owners
          simply choose for themselves — nothing breaks and nothing warns, because there
          is no weight to go on.
        </p>
      )}
    </fieldset>
  );
}
