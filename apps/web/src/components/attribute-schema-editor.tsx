'use client';

import { useState } from 'react';
import {
  CATEGORY_ATTRIBUTE_TYPES,
  MAX_ATTRIBUTE_DECIMAL_PLACES,
  MAX_ATTRIBUTE_OPTIONS,
  MAX_ATTRIBUTE_TEXT_LENGTH,
  MAX_CATEGORY_ATTRIBUTES,
  RECOMMENDED_MAX_CATEGORY_ATTRIBUTES,
} from '@platform/contracts';
import type { CategoryAttribute, CategoryAttributeType } from '@platform/contracts';

/**
 * The category's attribute schema, edited as a list of rows.
 *
 * **This is the one control in the slice that has to be general.** The Phase 2
 * exit gate is that a listing renders its category's fields without a frontend
 * change per field, and that is only achievable if what an administrator can
 * define is drawn from a closed vocabulary every renderer already handles
 * (ADR 0027). So the type select offers four options and no more, and each type
 * reveals exactly the settings that type has.
 *
 * The rows are serialised into one hidden input rather than posted as named
 * fields. A repeating field set with indexed names — `attributes[0][options][1]`
 * — has to be reassembled on the server by a parser that duplicates the shape
 * the contract already describes, and the two drift the moment a type is added.
 * One JSON value is validated by `categoryAttributesSchema` itself, which is the
 * same check the API runs.
 */

interface OptionDraft {
  readonly id: string;
  readonly value: string;
  readonly label: string;
}

interface AttributeDraft {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: CategoryAttributeType;
  readonly maxLength: number;
  readonly unit: string;
  readonly decimalPlaces: number;
  readonly options: readonly OptionDraft[];
}

/** Human wording for the vocabulary. The values themselves are the contract's. */
const TYPE_LABELS: Record<CategoryAttributeType, string> = {
  text: 'Text — a short free description',
  number: 'Number — a quantity with a unit',
  choice: 'Choice — exactly one of a list',
  'choice-many': 'Choice — any number of a list',
};

const DEFAULT_TEXT_LENGTH = 60;

/**
 * Ids for React keys and label association, stable across re-renders.
 *
 * Not the attribute key: that is the administrator's to type, is empty on a
 * fresh row, and changes as they type — using it would remount every input on
 * each keystroke and lose the caret.
 */
let sequence = 0;
const nextId = (): string => `draft-${String(++sequence)}`;

/** An emptied number input reads as NaN. Zero is the value that fails usefully. */
function zeroIfBlank(value: number): number {
  return Number.isNaN(value) ? 0 : value;
}

function emptyOption(): OptionDraft {
  return { id: nextId(), value: '', label: '' };
}

function emptyAttribute(): AttributeDraft {
  return {
    id: nextId(),
    key: '',
    label: '',
    required: false,
    type: 'text',
    maxLength: DEFAULT_TEXT_LENGTH,
    unit: '',
    decimalPlaces: 0,
    // Two, because `choice` needs two and starting with none makes the commonest
    // next action invisible.
    options: [emptyOption(), emptyOption()],
  };
}

/** An existing schema, opened for editing. */
function toDrafts(attributes: readonly CategoryAttribute[]): readonly AttributeDraft[] {
  return attributes.map((attribute) => ({
    ...emptyAttribute(),
    id: nextId(),
    key: attribute.key,
    label: attribute.label,
    required: attribute.required,
    type: attribute.type,
    maxLength: attribute.type === 'text' ? attribute.maxLength : DEFAULT_TEXT_LENGTH,
    unit: attribute.type === 'number' ? attribute.unit : '',
    decimalPlaces: attribute.type === 'number' ? attribute.decimalPlaces : 0,
    options:
      attribute.type === 'choice' || attribute.type === 'choice-many'
        ? attribute.options.map((option) => ({ ...option, id: nextId() }))
        : [emptyOption(), emptyOption()],
  }));
}

/**
 * What gets posted.
 *
 * Deliberately not validated here. Whatever this produces is checked by the
 * contract in the server action and again by the API, and a third opinion in a
 * component is the one that drifts — it would be the only copy with no test
 * proving it agrees with the other two.
 */
function toAttributes(drafts: readonly AttributeDraft[]): readonly CategoryAttribute[] {
  return drafts.map((draft) => {
    const core = {
      key: draft.key.trim(),
      label: draft.label.trim(),
      required: draft.required,
    };

    switch (draft.type) {
      case 'text':
        return { ...core, type: 'text', maxLength: draft.maxLength };
      case 'number':
        return {
          ...core,
          type: 'number',
          unit: draft.unit.trim(),
          decimalPlaces: draft.decimalPlaces,
        };
      case 'choice':
      case 'choice-many':
        return {
          ...core,
          type: draft.type,
          options: draft.options.map((option) => ({
            value: option.value.trim(),
            label: option.label.trim(),
          })),
        };
    }
  });
}

export function AttributeSchemaEditor({
  name,
  initial,
  idPrefix,
}: {
  /** The hidden field the server action reads. */
  readonly name: string;
  readonly initial?: readonly CategoryAttribute[];
  /** Distinguishes the create form's ids from each category's row form. */
  readonly idPrefix: string;
}) {
  const [drafts, setDrafts] = useState<readonly AttributeDraft[]>(() =>
    toDrafts(initial ?? []),
  );

  const update = (id: string, change: Partial<AttributeDraft>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...change } : draft)),
    );
  };

  const move = (index: number, by: number) => {
    setDrafts((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const reordered = [...current];
      const [moved] = reordered.splice(index, 1);
      if (moved === undefined) return current;
      reordered.splice(target, 0, moved);
      return reordered;
    });
  };

  const full = drafts.length >= MAX_CATEGORY_ATTRIBUTES;

  return (
    <fieldset>
      <legend>Attributes</legend>

      <p>
        The fields an owner fills in when listing something in this category.{' '}
        <strong>Keep this short.</strong> A mature hire company with thousands of
        products uses three per item; more than {RECOMMENDED_MAX_CATEGORY_ATTRIBUTES}{' '}
        and people abandon the listing form.
      </p>
      <p>
        Attributes are part of the configuration, so changing them saves a new version
        and listings already created keep the set they were filled in against.{' '}
        <strong>The order here is the order the fields appear in.</strong>
      </p>

      {/*
        The serialised value. Rendered whatever the state, including empty, so an
        empty schema is posted as `[]` rather than as an absent field — the
        server refuses an absent one rather than guessing it meant nothing.
      */}
      <input type="hidden" name={name} value={JSON.stringify(toAttributes(drafts))} />

      {drafts.length === 0 ? (
        <p>
          No attributes. A category can have none — it just means a listing carries only
          the fields every listing has.
        </p>
      ) : (
        <ol>
          {drafts.map((draft, index) => (
            <li key={draft.id}>
              <AttributeRow
                draft={draft}
                idPrefix={`${idPrefix}-${draft.id}`}
                position={index + 1}
                of={drafts.length}
                onChange={(change) => {
                  update(draft.id, change);
                }}
                onRemove={() => {
                  setDrafts((current) => current.filter((one) => one.id !== draft.id));
                }}
                onMove={(by) => {
                  move(index, by);
                }}
              />
            </li>
          ))}
        </ol>
      )}

      <p>
        <button
          type="button"
          onClick={() => {
            setDrafts((current) => [...current, emptyAttribute()]);
          }}
          disabled={full}
        >
          Add an attribute
        </button>
        {full ? (
          <span role="status">
            {' '}
            {MAX_CATEGORY_ATTRIBUTES} is the maximum. That is far above what any
            category should need.
          </span>
        ) : null}
      </p>
    </fieldset>
  );
}

function AttributeRow({
  draft,
  idPrefix,
  position,
  of,
  onChange,
  onRemove,
  onMove,
}: {
  readonly draft: AttributeDraft;
  readonly idPrefix: string;
  readonly position: number;
  readonly of: number;
  readonly onChange: (change: Partial<AttributeDraft>) => void;
  readonly onRemove: () => void;
  readonly onMove: (by: number) => void;
}) {
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <fieldset>
      <legend>
        Attribute {position} of {of}
      </legend>

      <p>
        <label htmlFor={id('label')}>Label</label>
        <input
          id={id('label')}
          type="text"
          value={draft.label}
          onChange={(event) => {
            onChange({ label: event.target.value });
          }}
        />
      </p>

      <p>
        <label htmlFor={id('key')}>Stored name</label>
        <input
          id={id('key')}
          type="text"
          value={draft.key}
          placeholder="power_source"
          aria-describedby={id('key-help')}
          onChange={(event) => {
            onChange({ key: event.target.value });
          }}
        />
      </p>
      <p id={id('key-help')}>
        Lowercase words joined by underscores. <strong>Permanent in practice</strong> —
        listings store their values against it, so renaming it later leaves those values
        pointing at a field that no longer exists.
      </p>

      <p>
        <label htmlFor={id('type')}>Type</label>
        <select
          id={id('type')}
          value={draft.type}
          onChange={(event) => {
            onChange({ type: event.target.value as CategoryAttributeType });
          }}
        >
          {CATEGORY_ATTRIBUTE_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </p>

      {draft.type === 'text' ? (
        <p>
          <label htmlFor={id('maxLength')}>Longest answer allowed</label>
          <input
            id={id('maxLength')}
            type="number"
            min={1}
            max={MAX_ATTRIBUTE_TEXT_LENGTH}
            value={draft.maxLength}
            onChange={(event) => {
              // `valueAsNumber` is NaN for an empty number input, and
              // `JSON.stringify` writes NaN as null — so clearing the field
              // would post `"maxLength": null` and the contract would answer
              // "expected number, received null", naming a type rather than
              // anything on screen. Zero fails the same check with "must be at
              // least 1", which points at the field they just emptied.
              onChange({ maxLength: zeroIfBlank(event.target.valueAsNumber) });
            }}
          />
        </p>
      ) : null}

      {draft.type === 'number' ? (
        <>
          <p>
            <label htmlFor={id('unit')}>Unit</label>
            <input
              id={id('unit')}
              type="text"
              value={draft.unit}
              placeholder="kg"
              aria-describedby={id('unit-help')}
              onChange={(event) => {
                onChange({ unit: event.target.value });
              }}
            />
          </p>
          <p id={id('unit-help')}>
            Shown after the number. It is a label, not a conversion — 2.5 kg and 2500 g
            are different attributes, not the same one in different units.
          </p>

          <p>
            <label htmlFor={id('decimalPlaces')}>Decimal places</label>
            <select
              id={id('decimalPlaces')}
              value={draft.decimalPlaces}
              onChange={(event) => {
                onChange({ decimalPlaces: Number(event.target.value) });
              }}
            >
              {Array.from({ length: MAX_ATTRIBUTE_DECIMAL_PLACES + 1 }, (_, places) => (
                <option key={places} value={places}>
                  {places === 0 ? 'Whole numbers only' : `${String(places)}`}
                </option>
              ))}
            </select>
          </p>
        </>
      ) : null}

      {draft.type === 'choice' || draft.type === 'choice-many' ? (
        <OptionsEditor
          draft={draft}
          idPrefix={idPrefix}
          onChange={(options) => {
            onChange({ options });
          }}
        />
      ) : null}

      <p>
        <label htmlFor={id('required')}>
          <input
            id={id('required')}
            type="checkbox"
            checked={draft.required}
            onChange={(event) => {
              onChange({ required: event.target.checked });
            }}
          />{' '}
          An owner must answer this
        </label>
      </p>

      <p>
        <button
          type="button"
          onClick={() => {
            onMove(-1);
          }}
          disabled={position === 1}
        >
          Move up
        </button>{' '}
        <button
          type="button"
          onClick={() => {
            onMove(1);
          }}
          disabled={position === of}
        >
          Move down
        </button>{' '}
        <button type="button" onClick={onRemove}>
          Remove {draft.label.trim() === '' ? 'this attribute' : draft.label.trim()}
        </button>
      </p>
    </fieldset>
  );
}

function OptionsEditor({
  draft,
  idPrefix,
  onChange,
}: {
  readonly draft: AttributeDraft;
  readonly idPrefix: string;
  readonly onChange: (options: readonly OptionDraft[]) => void;
}) {
  const id = (field: string) => `${idPrefix}-${field}`;

  // A single-answer question with one option asks something already answered;
  // a checkbox group with one is a legitimate yes/no. The contract enforces
  // both — this only stops the button offering a removal that will be refused.
  const floor = draft.type === 'choice' ? 2 : 1;

  return (
    <fieldset>
      <legend>Options</legend>

      <ol>
        {draft.options.map((option, index) => (
          <li key={option.id}>
            <p>
              <label htmlFor={id(`option-${option.id}-label`)}>Shown as</label>
              <input
                id={id(`option-${option.id}-label`)}
                type="text"
                value={option.label}
                onChange={(event) => {
                  onChange(
                    draft.options.map((one) =>
                      one.id === option.id
                        ? { ...one, label: event.target.value }
                        : one,
                    ),
                  );
                }}
              />
            </p>
            <p>
              <label htmlFor={id(`option-${option.id}-value`)}>Stored as</label>
              <input
                id={id(`option-${option.id}-value`)}
                type="text"
                value={option.value}
                placeholder="cordless"
                onChange={(event) => {
                  onChange(
                    draft.options.map((one) =>
                      one.id === option.id
                        ? { ...one, value: event.target.value }
                        : one,
                    ),
                  );
                }}
              />
            </p>
            <p>
              <button
                type="button"
                disabled={draft.options.length <= floor}
                onClick={() => {
                  onChange(draft.options.filter((one) => one.id !== option.id));
                }}
              >
                Remove option {index + 1}
              </button>
            </p>
          </li>
        ))}
      </ol>

      <p>
        <button
          type="button"
          disabled={draft.options.length >= MAX_ATTRIBUTE_OPTIONS}
          onClick={() => {
            onChange([...draft.options, emptyOption()]);
          }}
        >
          Add an option
        </button>
      </p>
    </fieldset>
  );
}
