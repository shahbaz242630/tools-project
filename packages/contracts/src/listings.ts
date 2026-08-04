/**
 * Listings — the first thing a *user* creates rather than an administrator.
 *
 * Its own file rather than part of `catalogue.ts`, though BRD §5.1 puts both in
 * the Catalogue module. A category is configuration written by one of us and
 * read by everybody; a listing is content written by a stranger about an object
 * we have never seen. They diverge immediately — a listing acquires media,
 * a fuzzed location, prices, moderation state and a lifecycle, none of which a
 * category has — and the authority to write one is completely different.
 *
 * **A draft is deliberately permissive.** §8.3 says owners "create draft
 * listings and save progress", so this shape holds a half-finished thing on
 * purpose. Completeness is enforced at publication (slice 2.8), not here.
 * Getting that backwards would mean an owner cannot save until they have
 * everything, which is exactly what makes people abandon a listing form.
 */

import { z } from 'zod';
import { boundedMoneySchema, moneySchema } from './money.js';
import { categorySlugSchema } from './catalogue.js';
import { parseWith } from './parse.js';

/** Where an owner creates listings and lists their own. */
export const LISTINGS_PATH = '/listings';
export const LISTINGS_ROUTE = '/listings';

/** One listing, addressed by id — it has no stable public slug until 2.12. */
export function listingPath(id: string): string {
  return `/listings/${encodeURIComponent(id)}`;
}

export const LISTING_ROUTE = '/listings/:id';

/**
 * Where any signed-in user reads the categories they could list in.
 *
 * Separate from `/admin/categories`, which requires the admin role and a second
 * factor. This returns the minimum an owner needs to choose one, and it exists
 * because a create form with nothing to choose from is a dead control.
 */
export const CATEGORY_OPTIONS_PATH = '/categories';
export const CATEGORY_OPTIONS_ROUTE = '/categories';

export const LISTING_TITLE_MIN_LENGTH = 3;
export const LISTING_TITLE_MAX_LENGTH = 100;
export const LISTING_DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * What the listing is called, in a search result and on a card.
 *
 * Control and format characters are rejected for the reason `displayName` gives:
 * U+202E reverses the rendering of everything after it, which is how a title is
 * made to read as something it is not, and a newline breaks every list the title
 * appears in. This is a single-line field.
 */
export const listingTitleSchema = z
  .string()
  .trim()
  .min(
    LISTING_TITLE_MIN_LENGTH,
    `must be at least ${LISTING_TITLE_MIN_LENGTH} characters`,
  )
  .max(
    LISTING_TITLE_MAX_LENGTH,
    `must be at most ${LISTING_TITLE_MAX_LENGTH} characters`,
  )
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    'must not contain control or direction-changing characters',
  );

/**
 * The description — **required to be present, allowed to be empty.**
 *
 * That distinction is the whole design of a draft. ADR 0025's rule stands: an
 * optional field is a silent default, and a caller that forgot it should get a
 * 400 rather than a quietly blanked description. But a *draft* legitimately has
 * nothing written yet, so the empty string is a real value rather than a missing
 * one. Publication is where non-empty becomes a requirement (§8.3, slice 2.8).
 *
 * Newlines are allowed — it is a paragraph field — so `\p{Cc}` cannot be
 * rejected wholesale the way it is on the title. Everything else in that class
 * still is.
 */
export const listingDescriptionSchema = z
  .string()
  .trim()
  .max(
    LISTING_DESCRIPTION_MAX_LENGTH,
    `must be at most ${String(LISTING_DESCRIPTION_MAX_LENGTH)} characters`,
  )
  .refine(
    // The allowed whitespace controls are removed first, then the same test the
    // title uses is applied to what is left. Expressing the exception inside the
    // character class needs the `v` flag's set difference, which reads like a
    // puzzle and depends on the compilation target — this does not.
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\r\n\t]/g, '')),
    'must not contain control or direction-changing characters',
  );

/**
 * What it would cost to replace the item, and the reason it is bounded.
 *
 * §8.7.1 builds the damage excess from this — "the greater of a fixed floor or a
 * percentage of replacement value, plus a ceiling" — so a wrong number here
 * becomes a wrong amount of somebody's money held on a card. The commonest way
 * to get it wrong is entering pounds where pence are meant, which is a factor of
 * a hundred, so the range is wide enough to be uncontroversial and narrow enough
 * to catch that.
 *
 * **Platform-wide sanity bounds, not policy.** A per-category cap belongs in
 * category configuration beside the deposit bands §8.2 already promises, and
 * putting one here would hard-code a commercial limit in a validator.
 */
export const MIN_REPLACEMENT_VALUE_MINOR = 100;
export const MAX_REPLACEMENT_VALUE_MINOR = 10_000_000;

export const replacementValueSchema = boundedMoneySchema({
  minimum: MIN_REPLACEMENT_VALUE_MINOR,
  maximum: MAX_REPLACEMENT_VALUE_MINOR,
  minimumLabel: '£1',
  maximumLabel: '£100,000',
});

/**
 * Where a listing is in its life.
 *
 * Only `DRAFT` exists, and the rest of the vocabulary — published, paused,
 * archived, and the moderation states beside them — arrives in slice 2.8. It is
 * here now rather than later because retrofitting a status column onto rows that
 * already carry bookings is a migration nobody wants, and because a listing with
 * no status is indistinguishable from one that is live.
 */
export const LISTING_STATUSES = ['DRAFT'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const listingStatusSchema = z.enum(LISTING_STATUSES);

/**
 * Creating a draft.
 *
 * The **category slug**, not its id: it is the category's identity (§8.17) and
 * the only part a form can sensibly carry. **The version is not supplied by the
 * caller** — the server pins whichever is current at the moment the draft is
 * written. A client-chosen version would let a stale form pin configuration that
 * was replaced while it sat open, which is the one thing the pin exists to
 * prevent.
 */
export const listingDraftSchema = z.object({
  categorySlug: categorySlugSchema,
  title: listingTitleSchema,
  description: listingDescriptionSchema,
  replacementValue: replacementValueSchema,
});

export type ListingDraftInput = z.infer<typeof listingDraftSchema>;

export function parseListingDraft(raw: unknown): ListingDraftInput {
  return parseWith(listingDraftSchema, 'The listing', raw);
}

/**
 * A listing as its owner sees it.
 *
 * `categoryVersionNumber` is present because it is the honest answer to "which
 * rules is this listing being read under", and from 2.8 it is what tells an
 * owner their draft was written against configuration that has since changed.
 * The owner id is *not* here: this shape is only ever served to the owner, so
 * echoing their own id back adds nothing and would be one more field to strip
 * when the public projection arrives in 2.10.
 */
export interface OwnerListing {
  readonly id: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly categoryVersionNumber: number;
  readonly title: string;
  readonly description: string;
  readonly replacementValue: z.infer<typeof moneySchema>;
  readonly status: ListingStatus;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

const ownerListingSchema = z.object({
  id: z.string().uuid(),
  categorySlug: z.string(),
  categoryName: z.string(),
  categoryVersionNumber: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  replacementValue: moneySchema,
  status: listingStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function parseOwnerListing(raw: unknown): OwnerListing {
  return parseWith(ownerListingSchema, 'The listing response', raw);
}

/**
 * A category as somebody choosing one sees it.
 *
 * Deliberately not `AdminCategory`. That shape carries the risk level, the
 * reportable-activity flag and the whole attribute schema — administrative
 * configuration that an owner picking "Outdoor and gardening" from a list has no
 * business receiving. Two shapes rather than one with optional fields, for the
 * reason `profiles.ts` sets out: an optional field compiles whether or not the
 * API remembered to strip it.
 *
 * The attribute schema arrives here in slice 2.4b, when the form has fields to
 * render from it.
 */
export interface CategoryOption {
  readonly slug: string;
  readonly name: string;
}

const categoryOptionListSchema = z.object({
  categories: z.array(z.object({ slug: z.string(), name: z.string() })),
});

export function parseCategoryOptions(raw: unknown): {
  readonly categories: readonly CategoryOption[];
} {
  return parseWith(categoryOptionListSchema, 'The category list', raw);
}
