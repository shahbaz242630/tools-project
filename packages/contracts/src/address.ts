/**
 * A UK postal address, as the platform asks for one.
 *
 * **Its own file from slice 2.5a, on the precedent `money.ts` set in 2.4a.**
 * A profile has a home address and a listing has a collection address, and the
 * two must agree about what an address *is* — the same fields, the same limits,
 * the same normalisation. Two definitions would drift, and the drift would
 * surface as a postcode the profile accepts and the listing refuses.
 *
 * **The public/private split is the reason this shape matters.** Every address
 * the platform holds separates into a coarse half anybody may see — the outward
 * code and the post town — and a precise half almost nobody may. `postcode.ts`
 * in `@platform/core` explains why the line falls there: an outward code covers
 * thousands of homes, a full postcode averages about fifteen and is often one
 * building. Nothing in this file publishes anything; it defines what is
 * collected, and each module decides which half it may return (BRD §8.4.1).
 */

import { Postcode } from '@platform/core';
import { z } from 'zod';

export const ADDRESS_LINE_MAX_LENGTH = 100;
export const TOWN_MAX_LENGTH = 60;

/**
 * A UK postcode, normalised to `BS7 8AA` on the way in.
 *
 * Normalising in the contract rather than in a service means every layer below
 * sees one representation, and the outward code derived from it is derived from
 * the same string that gets stored.
 */
export const postcodeSchema = z
  .string()
  .trim()
  .refine(Postcode.isValid, 'must be a valid UK postcode')
  .transform(Postcode.parse);

/**
 * An address as somebody supplies it.
 *
 * **All-or-nothing.** Callers make the whole object nullable; the fields inside
 * it are not individually optional. A postcode with no street line is not an
 * address, and a street line with no postcode cannot be geocoded — making the
 * fields individually optional would let both halves of that pair go missing
 * one release apart, each looking reasonable on its own.
 */
export const postalAddressSchema = z.object({
  line1: z.string().trim().min(1, 'is required').max(ADDRESS_LINE_MAX_LENGTH),
  /** Flats, building names. Genuinely optional — most addresses have no second line. */
  line2: z.string().trim().max(ADDRESS_LINE_MAX_LENGTH).nullable().default(null),
  town: z.string().trim().min(1, 'is required').max(TOWN_MAX_LENGTH),
  postcode: postcodeSchema,
});
export type PostalAddress = z.infer<typeof postalAddressSchema>;

/**
 * The response shape for an address, on the way back out.
 *
 * Separate from the input schema because the input **transforms** — it
 * normalises the postcode and defaults `line2` — and a response schema that
 * transforms would quietly rewrite what the API actually sent, which is the one
 * thing a response check exists to detect.
 */
export const postalAddressResponseSchema = z.object({
  line1: z.string(),
  line2: z.string().nullable(),
  town: z.string(),
  postcode: z.string(),
});

/**
 * What anyone may see: the district and the town, never the rest.
 *
 * A type of its own rather than a projection applied at a call site. The
 * difference between this and `PostalAddress` is the whole of BRD §8.4.1's
 * disclosure rule, and a type error at the point of construction is a stronger
 * guarantee than a `select` somebody has to remember.
 */
export const coarseLocationSchema = z.object({
  /** `BS7` — a postal district, covering thousands of addresses. */
  outwardCode: z.string(),
  /** Post town. Coarse enough to publish, and it makes the district legible. */
  town: z.string(),
});
export type CoarseLocation = z.infer<typeof coarseLocationSchema>;
