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
import { postalAddressResponseSchema, postalAddressSchema } from './address.js';
import type { PostalAddress } from './address.js';
import { boundedMoneySchema, moneySchema } from './money.js';
import { categoryAttributesSchema, categorySlugSchema } from './catalogue.js';
import type { CategoryAttribute } from './catalogue.js';
import {
  categoryTransportOptionsSchema,
  transportRequirementSchema,
} from './transport.js';
import type { CategoryTransportOption, TransportRequirement } from './transport.js';
import type { ListingAttributeValues } from './attribute-values.js';
import { hasUnsafeCharacters, UNSAFE_CHARACTERS_MESSAGE } from './text.js';
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
  .refine((value) => !hasUnsafeCharacters(value), UNSAFE_CHARACTERS_MESSAGE);

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
 * still is, which is what `allowLineBreaks` means in `text.ts`.
 */
export const listingDescriptionSchema = z
  .string()
  .trim()
  .max(
    LISTING_DESCRIPTION_MAX_LENGTH,
    `must be at most ${String(LISTING_DESCRIPTION_MAX_LENGTH)} characters`,
  )
  .refine(
    (value) => !hasUnsafeCharacters(value, { allowLineBreaks: true }),
    UNSAFE_CHARACTERS_MESSAGE,
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
  /**
   * The version of the category the form was built from — **stated, not chosen.**
   *
   * The server still pins whichever version is current when it writes, exactly
   * as it did in 2.4a: a client-chosen pin is the stale pin the version exists
   * to prevent. This is the opposite direction. It says which schema these
   * answers were entered against, so that if the category was reconfigured while
   * the form sat open, the mismatch is *noticed* rather than surfacing as an
   * answer to a field that no longer exists.
   *
   * Required rather than optional. An absent version would have to be read as
   * "whatever is current", which is precisely the assumption that makes the race
   * invisible.
   */
  categoryVersionNumber: z.number().int().positive(),
  /**
   * The answers to that category's attributes, keyed by attribute key.
   *
   * **Unknown here, and validated elsewhere.** Which keys are legal and what
   * shape each value takes is category configuration, so it cannot live in a
   * static schema — `validateAttributeValues` does that work in the Catalogue
   * service against the schema on the version actually being pinned.
   *
   * **Required, and `{}` is a legitimate value.** ADR 0025's rule, for the third
   * time: an optional field is a silent default, and a caller that forgot the
   * answers should get a 400 rather than a listing that quietly has none.
   */
  attributes: z.record(z.string(), z.unknown()),
  /**
   * What is needed to collect and carry the item (§8.3, ADR 0031).
   *
   * **Required to be present, allowed to be null** — the same distinction the
   * description draws, and for the same reason. A draft legitimately has not
   * answered this yet; a caller that omitted the field entirely has forgotten
   * it, and should hear so rather than have "not answered" assumed for them.
   *
   * Which values are legal is *category* configuration, so it cannot be decided
   * here: this checks only that the value is in the platform's vocabulary at
   * all. Whether this category offers it is checked in the Catalogue service
   * against the options on the version being pinned, exactly as attribute
   * values are.
   */
  transportRequirement: transportRequirementSchema.nullable(),
  /**
   * Whether it takes two people to lift.
   *
   * **A separate field from the requirement above, deliberately** (ADR 0031).
   * The BRD's example list has "two-person lift" beside the vehicle sizes, but
   * they are different axes: an item can need a van *and* two people, and one
   * choice would force an owner to discard one of two true facts.
   *
   * **Not category configuration.** Whether a category should offer a trailer
   * varies; whether a given object takes two people to pick up does not. It is
   * asked of every listing, and it feeds §8.9's handover checklist regardless of
   * what the category configured.
   */
  requiresTwoPersonLift: z.boolean(),
  /**
   * Where the item is collected from (§8.3's "collection location").
   *
   * **Required to be present, allowed to be null** — the third field on this
   * shape to draw that distinction, and for the same reason. A draft
   * legitimately has not said where the thing lives yet; a caller that omitted
   * the field has forgotten it. Publication is where a location becomes
   * mandatory (2.8), because a listing nobody can collect is not one anybody can
   * book.
   *
   * **What happens to it afterwards is the whole of slice 2.5.** The full
   * postcode and the street lines are private: they reach the renter only once a
   * booking authorises collection (§8.4.1). What is published is the outward
   * code and the town, derived on write and stored separately, so a public query
   * selects columns that have never held the rest. The **imprecise point** §8.3
   * asks for — a coordinate displaced by a persisted offset of at least 500 m —
   * arrives in 2.5b with the geocoder; there are no coordinates in the system
   * yet, and nothing renders a map.
   */
  collectionLocation: postalAddressSchema.nullable(),
});

export type ListingDraftInput = z.infer<typeof listingDraftSchema>;

/**
 * The listing's collection address, as its **owner** reads it back.
 *
 * They typed it, so they see it — the same rule `MyProfile` follows. This is the
 * only listing projection that carries the precise half, and 2.10's public one
 * carries `CoarseLocation` instead. Two types rather than one with nullable
 * fields, because an optional `postcode?: string` compiles whether or not the
 * API remembered to strip it.
 */
export type ListingCollectionLocation = PostalAddress;

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
  /**
   * The attribute schema **as pinned**, not as the category stands today.
   *
   * It travels with the listing because a value on its own is unreadable: `25`
   * means nothing without knowing it is a weight in kilograms at one decimal
   * place, and `cordless` means nothing without the label somebody chose it by.
   * Sending the current schema instead would render last month's answers under
   * this month's labels, which is the one thing pinning a version exists to
   * prevent.
   */
  readonly categoryAttributes: readonly CategoryAttribute[];
  readonly title: string;
  readonly description: string;
  readonly replacementValue: z.infer<typeof moneySchema>;
  /** Keyed by attribute key. An unanswered attribute is absent, never null. */
  readonly attributes: ListingAttributeValues;
  /**
   * What it takes to collect the item, or null on a draft that has not said.
   *
   * Read against the options on the **pinned** version, like everything else
   * here: a category that has since withdrawn an option does not make an
   * existing listing unreadable, it just means nobody new can choose it.
   */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * Where it is collected from, in full, or null on a draft that has not said.
   *
   * In full **because this shape is only ever served to the owner**, who typed
   * it. The public projection in 2.10 gets the outward code and the town and
   * nothing else, and it is a different type for exactly that reason.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  /**
   * Whether that address has been resolved to a point yet (slice 2.5b).
   *
   * **A boolean, never the coordinates.** BRD §8.4.1 keeps the true point out of
   * every response, and the published one is a Phase 3 concern that this
   * projection has no use for. What an owner needs from it is one fact: their
   * listing cannot be found by anybody searching nearby until this is true, and
   * slice 2.8 will refuse to publish it.
   *
   * False is ordinary rather than alarming — the geocoder may not recognise a
   * new postcode, or may have been unreachable when the listing was saved.
   * Saving again tries once more.
   */
  readonly isLocated: boolean;
  readonly status: ListingStatus;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The response check on a stored answer.
 *
 * Deliberately shape-only — that a value is a string, a number or a list of
 * strings. Whether it is a *legal* answer was settled against the pinned schema
 * when it was written, and re-deciding that on the way out would mean a schema
 * change could make an existing listing unreadable rather than merely outdated.
 */
const attributeValueSchema = z.union([z.string(), z.number(), z.array(z.string())]);

const ownerListingSchema = z.object({
  id: z.string().uuid(),
  categorySlug: z.string(),
  categoryName: z.string(),
  categoryVersionNumber: z.number().int().positive(),
  categoryAttributes: categoryAttributesSchema,
  title: z.string(),
  description: z.string(),
  replacementValue: moneySchema,
  attributes: z.record(z.string(), attributeValueSchema),
  transportRequirement: transportRequirementSchema.nullable(),
  requiresTwoPersonLift: z.boolean(),
  // The response shape, not the input one. The input normalises the postcode
  // and defaults `line2`; a response check that transformed would rewrite what
  // the API actually sent, which is the one thing this check exists to detect.
  collectionLocation: postalAddressResponseSchema.nullable(),
  isLocated: z.boolean(),
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
 * The attribute schema is here from slice 2.4b, because the form has fields to
 * render from it — that is the Phase 2 exit gate, and it is the whole reason
 * this endpoint returns more than a name. The risk level and the
 * reportable-activity flag stay out: they are how *we* administer a category,
 * not what an owner needs to describe a lawnmower.
 */
export interface CategoryOption {
  readonly slug: string;
  readonly name: string;
  /**
   * In render order, and it is the *current* schema — which is correct here and
   * would be wrong on `OwnerListing`. A form being filled in now is filling in
   * the configuration in force now; a listing saved last month is not.
   */
  readonly attributes: readonly CategoryAttribute[];
  /**
   * Which transport requirements this category offers, with their weight
   * thresholds — the current selection, for the same reason the attributes are
   * current: a form being filled in now is filling in the configuration in
   * force now.
   *
   * The thresholds travel because the suggestion is computed in the browser, as
   * the weight is typed. They are not secret — they are a hint about how heavy a
   * thing has to be before it needs a van, which is what the form is about to
   * tell the owner anyway.
   */
  readonly transportOptions: readonly CategoryTransportOption[];
  /**
   * Which version the above came from, so the draft can say what it was built
   * against and the server can notice if it has moved since.
   */
  readonly versionNumber: number;
}

const categoryOptionListSchema = z.object({
  categories: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      attributes: categoryAttributesSchema,
      transportOptions: categoryTransportOptionsSchema,
      versionNumber: z.number().int().positive(),
    }),
  ),
});

export function parseCategoryOptions(raw: unknown): {
  readonly categories: readonly CategoryOption[];
} {
  return parseWith(categoryOptionListSchema, 'The category list', raw);
}
