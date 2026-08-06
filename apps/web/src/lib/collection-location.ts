import { postalAddressSchema } from '@platform/contracts';
import type { PostalAddress } from '@platform/contracts';

/**
 * Four form fields to one collection address, or to nothing.
 *
 * Its own module rather than a helper inside the server action, for the reason
 * `replacement-value.ts` gives: a `'use server'` file cannot be imported by a
 * test without dragging in `next/headers` and Clerk, and this is a rule worth
 * testing directly.
 *
 * **The whole decision is what "blank" means, and it is not "some fields are
 * empty".** A draft may legitimately not say where the item is (§8.3), so all
 * four empty is a real answer: null, and the API stores no location. But a
 * *partly* filled address is not a blank one — it is somebody who started
 * typing — and reading it as null would silently discard what they wrote, with
 * no error anywhere. That is the exact failure 2.4b's "unknown keys are refused,
 * not dropped" exists to prevent, arriving by a different door.
 *
 * So: empty means empty, and anything else is validated in full.
 */
export type CollectionLocation =
  | { readonly ok: true; readonly value: PostalAddress | null }
  | { readonly ok: false; readonly message: string };

export interface CollectionLocationFields {
  readonly line1: string;
  readonly line2: string;
  readonly town: string;
  readonly postcode: string;
}

export function readCollectionLocation(
  fields: CollectionLocationFields,
): CollectionLocation {
  const line1 = fields.line1.trim();
  const line2 = fields.line2.trim();
  const town = fields.town.trim();
  const postcode = fields.postcode.trim();

  // `line2` counts towards "did they type anything". A person who filled in only
  // the flat number has still started, and telling them the rest is required is
  // more use than silently keeping none of it.
  if (line1 === '' && line2 === '' && town === '' && postcode === '') {
    return { ok: true, value: null };
  }

  const parsed = postalAddressSchema.safeParse({
    line1,
    // The contract's own field is nullable; an empty second line is genuinely
    // absent rather than an empty string, and most addresses have none.
    line2: line2 === '' ? null : line2,
    town,
    postcode,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: `Collection address — ${parsed.error.issues
        // Named by the label on the form rather than by the contract's field
        // name. `line1` appears nowhere on screen, and 2.4b's finding was
        // exactly this: an error naming a key the reader cannot see is an error
        // they cannot act on.
        .map((issue) => `${LABELS[String(issue.path[0])] ?? 'this'} ${issue.message}`)
        .join('; ')}.`,
    };
  }

  return { ok: true, value: parsed.data };
}

const LABELS: Record<string, string> = {
  line1: 'address line 1',
  line2: 'address line 2',
  town: 'the town',
  postcode: 'the postcode',
};
