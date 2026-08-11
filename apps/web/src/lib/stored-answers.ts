import { Scaled } from '@platform/core';
import type { CategoryAttribute, ListingAttributeValues } from '@platform/contracts';
import type { AttributeAnswers } from '../components/attribute-fields';

/**
 * Stored attribute values, turned back into what the form holds (slice 2.9b-i).
 *
 * **The exact inverse of what the API does on the way in**, and it has to be, or
 * an owner who opens the edit form and presses Save without touching anything
 * changes their own data. That is the failure this file exists to prevent, and
 * it is silent in both directions: nothing validates that a round trip is a
 * no-op, because the value is legal either way.
 *
 * The two representations differ for exactly one type. A `number` is stored as a
 * **scaled integer** whose scale is category configuration — `385` at one decimal
 * place is 38.5 kg — while the form holds and submits the text the person typed
 * (ADR 0029). `Scaled.toDecimalString` is the named inverse of the
 * `fromDecimalString` the server applies, so the pair cannot drift.
 *
 * **Read against a schema the caller supplies rather than the listing's own**,
 * which is the part worth understanding. The edit form renders the category's
 * *current* attributes (ADR 0042: editing brings a listing onto the current
 * configuration), while the values were stored against the version the listing
 * pinned. So this maps values onto whatever schema it is given:
 *
 * - a key the current schema does not have is **dropped**, because there is no
 *   field to render it in and the platform no longer asks the question;
 * - a key the current schema has and the listing never answered is **absent**,
 *   which is what an untouched field holds;
 * - a value whose stored shape does not match the current definition's type is
 *   dropped rather than coerced, because a `choice-many` answer rendered into a
 *   `text` box would be submitted back as the string `"a,b"`.
 */
export function toStoredAnswers(
  attributes: readonly CategoryAttribute[],
  values: ListingAttributeValues,
): AttributeAnswers {
  const answers: Record<string, string | readonly string[]> = {};

  for (const attribute of attributes) {
    const stored = values[attribute.key];
    if (stored === undefined) continue;

    switch (attribute.type) {
      case 'number':
        // Only a number becomes a number field. A stored string here would mean
        // the attribute was a `text` when the value was written and has since
        // been redefined, and `toDecimalString` would throw on it — taking down
        // an edit form over one field.
        if (typeof stored === 'number') {
          answers[attribute.key] = Scaled.toDecimalString(
            stored,
            attribute.decimalPlaces,
          );
        }
        break;

      case 'text':
      case 'choice':
        if (typeof stored === 'string') answers[attribute.key] = stored;
        break;

      case 'choice-many':
        // A copy rather than the array itself: the form owns its answers and
        // mutates them as fields change, and sharing the reference would let it
        // rewrite the listing object the page is still rendering from.
        if (Array.isArray(stored)) answers[attribute.key] = [...stored];
        break;
    }
  }

  return answers;
}
