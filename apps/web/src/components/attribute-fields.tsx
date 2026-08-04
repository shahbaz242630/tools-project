'use client';

import {
  MAX_ATTRIBUTE_TEXT_LENGTH,
  type AttributeOption,
  type CategoryAttribute,
} from '@platform/contracts';

/**
 * The fields a category asks for, drawn from its configuration.
 *
 * **This component is the Phase 2 exit gate.** BRD §14: *"a listing renders its
 * category-specific fields without frontend code changes for every field"*. It
 * knows the four types ADR 0027 defined and nothing whatsoever about
 * gardening — adding an attribute, a category, or a whole new vertical changes
 * configuration and not this file. Adding a fifth *type* would change it, which
 * is exactly the line the ADR drew: a type is a renderer.
 *
 * **Nothing here is marked `required`, and that is deliberate.** §8.3 says owners
 * create drafts and save progress, so a required attribute must not stop the
 * draft saving — it stops it *publishing* (slice 2.8). Putting the HTML
 * attribute on would be a control that refuses to do the thing the page says it
 * does, which is the dead-control rule from the other direction.
 */

/**
 * Answers as the form holds them: text for everything a person types or picks,
 * a list for a checkbox group.
 *
 * Numbers stay **strings** all the way to the API, which scales them against the
 * category's own `decimalPlaces`. The scale is configuration, so a client that
 * sent an already-scaled integer would be supplying both the value and the
 * meaning of the value, and no server could check it.
 */
export type AttributeAnswers = Readonly<Record<string, string | readonly string[]>>;

/**
 * What gets posted: the answered fields, in the schema's order.
 *
 * An unanswered field is **left out** rather than sent as an empty string, so
 * the platform has one representation of "not answered". Empty is what an
 * untouched input holds, and it is not an answer.
 */
export function toSubmittedAttributes(
  attributes: readonly CategoryAttribute[],
  answers: AttributeAnswers,
): Record<string, string | readonly string[]> {
  const submitted: Record<string, string | readonly string[]> = {};

  for (const attribute of attributes) {
    const answer = answers[attribute.key];
    if (answer === undefined) continue;
    if (typeof answer === 'string') {
      if (answer.trim() !== '') submitted[attribute.key] = answer.trim();
      continue;
    }
    if (answer.length > 0) submitted[attribute.key] = answer;
  }

  return submitted;
}

export function AttributeFields({
  attributes,
  answers,
  onChange,
  idPrefix = 'listing-attr',
}: {
  readonly attributes: readonly CategoryAttribute[];
  readonly answers: AttributeAnswers;
  readonly onChange: (key: string, value: string | readonly string[]) => void;
  readonly idPrefix?: string;
}) {
  if (attributes.length === 0) {
    // Not an error and not an empty box. A category with no attributes is a
    // legitimate configuration — it is what every category had before slice 2.2
    // — and saying so is better than a heading with nothing under it.
    return <p>This category asks for no extra details beyond the ones above.</p>;
  }

  return (
    <fieldset>
      <legend>Details for this category</legend>

      <p>
        These come from the category and may change if it is reconfigured.{' '}
        <strong>You can save a draft without them</strong> — the ones marked below have
        to be answered before you can publish.
      </p>

      {attributes.map((attribute) => (
        <AttributeField
          key={attribute.key}
          attribute={attribute}
          answer={answers[attribute.key]}
          id={`${idPrefix}-${attribute.key}`}
          onChange={(value) => {
            onChange(attribute.key, value);
          }}
        />
      ))}
    </fieldset>
  );
}

function AttributeField({
  attribute,
  answer,
  id,
  onChange,
}: {
  readonly attribute: CategoryAttribute;
  readonly answer: string | readonly string[] | undefined;
  readonly id: string;
  readonly onChange: (value: string | readonly string[]) => void;
}) {
  // The switch is exhaustive over the vocabulary and has no default. A fifth
  // type is a deploy (ADR 0027), and this is one of the places the compiler
  // should refuse to let it be forgotten.
  switch (attribute.type) {
    case 'text':
      return (
        <p>
          <label htmlFor={id}>
            {attribute.label} <Requirement attribute={attribute} />
          </label>
          <input
            id={id}
            type="text"
            maxLength={Math.min(attribute.maxLength, MAX_ATTRIBUTE_TEXT_LENGTH)}
            value={asText(answer)}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </p>
      );

    case 'number':
      return (
        <>
          <p>
            <label htmlFor={id}>
              {attribute.label} ({attribute.unit}) <Requirement attribute={attribute} />
            </label>
            {/*
              `type="text"` with a numeric input mode, never `type="number"`.
              A number input hands back a JavaScript number — and an emptied one
              hands back NaN, which `JSON.stringify` writes as null (the trap
              slice 2.2 paid for). The typed text goes to the API unchanged and
              is scaled there against the category's own decimal places.
            */}
            <input
              id={id}
              type="text"
              inputMode="decimal"
              value={asText(answer)}
              aria-describedby={`${id}-help`}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
          </p>
          <p id={`${id}-help`}>
            In {attribute.unit}.{' '}
            {attribute.decimalPlaces === 0
              ? 'Whole numbers only.'
              : `Up to ${String(attribute.decimalPlaces)} decimal place${
                  attribute.decimalPlaces === 1 ? '' : 's'
                }, for example ${exampleFor(attribute.decimalPlaces)}.`}
          </p>
        </>
      );

    case 'choice':
      return (
        <p>
          <label htmlFor={id}>
            {attribute.label} <Requirement attribute={attribute} />
          </label>
          <select
            id={id}
            value={asText(answer)}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            {/* The empty option is what "not answered yet" looks like on a
                draft. Without it a select silently answers the question with
                whichever option happens to be first. */}
            <option value="">No answer yet</option>
            {attribute.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </p>
      );

    case 'choice-many':
      return (
        <fieldset>
          <legend>
            {attribute.label} <Requirement attribute={attribute} />
          </legend>
          {attribute.options.map((option) => (
            <p key={option.value}>
              <label htmlFor={`${id}-${option.value}`}>
                <input
                  id={`${id}-${option.value}`}
                  type="checkbox"
                  checked={asList(answer).includes(option.value)}
                  onChange={(event) => {
                    onChange(
                      toggle(
                        attribute.options,
                        asList(answer),
                        option.value,
                        event.target.checked,
                      ),
                    );
                  }}
                />{' '}
                {option.label}
              </label>
            </p>
          ))}
        </fieldset>
      );
  }
}

/**
 * Says a field is needed to publish, not to save.
 *
 * The wording matters: "Required" beside a field on a form that will happily
 * save without it is a statement the page then contradicts.
 */
function Requirement({ attribute }: { readonly attribute: CategoryAttribute }) {
  return attribute.required ? <small>(needed before you can publish)</small> : null;
}

function asText(answer: string | readonly string[] | undefined): string {
  return typeof answer === 'string' ? answer : '';
}

function asList(answer: string | readonly string[] | undefined): readonly string[] {
  return Array.isArray(answer) ? answer : [];
}

/**
 * Add or remove one choice, keeping the schema's order.
 *
 * Order is rebuilt from the definition rather than appended to, so ticking three
 * boxes in any sequence produces one value — the API stores them in schema order
 * too, and two places computing the same order differently is how a form and its
 * stored result start disagreeing.
 */
function toggle(
  options: readonly AttributeOption[],
  chosen: readonly string[],
  value: string,
  checked: boolean,
): readonly string[] {
  const next = new Set(chosen);
  if (checked) next.add(value);
  else next.delete(value);
  return options.map((option) => option.value).filter((option) => next.has(option));
}

/** "0.5" at one place, "0.05" at two — the smallest thing the scale can say. */
function exampleFor(decimalPlaces: number): string {
  return `0.${'0'.repeat(decimalPlaces - 1)}5`;
}
