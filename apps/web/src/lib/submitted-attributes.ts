/**
 * The category-specific answers, as they arrive from the form.
 *
 * Its own module rather than a helper inside the server action, for the reason
 * `replacement-value.ts` gives: a `'use server'` file cannot be imported by a
 * test without dragging in `next/headers` and Clerk, and logic does not belong
 * in a route handler anyway (CLAUDE.md).
 *
 * **It deliberately does almost nothing.** The form posts one hidden JSON value
 * (see `ListingForm`), and all this does is confirm it is a set of answers at
 * all. Whether the keys exist, what type each value must be and what a number
 * means at that category's scale are questions only the API can answer, because
 * only the API holds the schema on the version it is about to pin. A second
 * opinion here would be the one that drifts.
 */

export type SubmittedAttributes =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

const NOT_A_FORM =
  'The details for this category could not be read. Reload the page and try again — ' +
  'nothing has been saved.';

export function readSubmittedAttributes(
  raw: FormDataEntryValue | null,
): SubmittedAttributes {
  // A file entry, or no field at all. Both mean the form was not the one we
  // rendered, so there is nothing to salvage by guessing.
  if (typeof raw !== 'string') return { ok: false, message: NOT_A_FORM };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: NOT_A_FORM };
  }

  // `typeof [] === 'object'`, and an array would pass every later check by
  // having no keys — storing "no answers" for something that plainly was not a
  // set of them.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: NOT_A_FORM };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}
