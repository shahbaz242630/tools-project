import { Scaled } from '@platform/core';
import type { AttributeOption, CategoryAttribute } from '@platform/contracts';

/**
 * One **stored, present** answer, rendered from its definition.
 *
 * A value cannot be read without the definition beside it: `25` is meaningless
 * until something says it is kilograms at one decimal place, and `cordless` is
 * meaningless without the label it was chosen by. Both come from the schema the
 * listing **pinned**, so an answer given last month is shown under the labels it
 * was given under rather than under whatever the category says today (ADR 0029).
 *
 * **Extracted from the owner's page in slice 2.10**, when the public page needed
 * the same rendering. Two copies of this would drift in exactly one direction —
 * one of them would eventually format a scaled integer with `toFixed`, which
 * ADR 0002 bans and which takes a float, the one thing these values have never
 * been.
 *
 * **It renders a value that exists, and nothing else.** Absence is deliberately
 * not handled here, because the two pages mean different things by it: an owner
 * is told *"not answered yet — needed before you can publish"*, which is a
 * to-do list, and a stranger is shown nothing at all, because a public page
 * listing what somebody has not filled in is a page about our form rather than
 * about the item. Folding both into one component would put owner-facing copy
 * one boolean away from a page the whole internet reads.
 */
export function AttributeValue({
  attribute,
  value,
}: {
  readonly attribute: CategoryAttribute;
  readonly value: string | number | readonly string[];
}) {
  switch (attribute.type) {
    case 'text':
      return <>{String(value)}</>;

    case 'number':
      // Formatted by the primitive that stored it, never by `toFixed` — which
      // is banned (ADR 0002) and takes a float, the one thing this value has
      // never been.
      return typeof value === 'number' ? (
        <>{Scaled.format(value, attribute.decimalPlaces, attribute.unit)}</>
      ) : (
        <>{String(value)}</>
      );

    case 'choice':
      return <>{labelFor(attribute.options, value)}</>;

    case 'choice-many':
      return Array.isArray(value) ? (
        <>{value.map((one) => labelFor(attribute.options, one)).join(', ')}</>
      ) : (
        <>{String(value)}</>
      );
  }
}

/**
 * The label an option was chosen by, falling back to the stored value.
 *
 * The fallback should be unreachable — a value is validated against these very
 * options before it is stored, and the schema shown here is the one it was
 * validated against. Showing the raw value rather than nothing means that if it
 * ever *is* reached, the page says something true instead of going blank.
 */
function labelFor(options: readonly AttributeOption[], value: unknown): string {
  const match = options.find((option) => option.value === value);
  return match?.label ?? String(value);
}
