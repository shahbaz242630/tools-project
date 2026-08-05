import type { PrismaClient } from '@platform/database';
import type {
  CategoryAttribute,
  CategoryTransportOption,
  ListingAttributeValues,
  ListingStatus,
  TransportRequirement,
} from '@platform/contracts';
import {
  LISTING_STATUSES,
  TRANSPORT_REQUIREMENTS,
  parseCategoryAttributes,
  parseCategoryTransportOptions,
} from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import { Money } from '@platform/core';
import { CategoryChangedError, UnknownCategoryError } from './listing-store.js';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  ListingDraft,
  ListingRecord,
  ListingStore,
} from './listing-store.js';

/**
 * Postgres-backed listings.
 *
 * The one thing worth reading closely is `createDraft`: it resolves the category
 * and pins its current version **inside the same statement that writes the
 * row**, so no caller ever holds a version id long enough for it to go stale.
 */
export class PrismaListingStore implements ListingStore, CategoryOptionSource {
  constructor(private readonly prisma: PrismaClient) {}

  async createDraft(draft: ListingDraft): Promise<ListingRecord> {
    const category = await this.prisma.category.findUnique({
      where: { slug: draft.categorySlug },
      include: LATEST_VERSION,
    });
    if (category === null) throw new UnknownCategoryError(draft.categorySlug);

    const current = category.versions[0];
    // Unreachable while `CategoryStore.create` writes both rows together, which
    // is the only path that makes a category. Guarding rather than asserting,
    // because the alternative is a crash reading `undefined.id`.
    if (current === undefined) throw new UnknownCategoryError(draft.categorySlug);

    // The version about to be pinned, checked against the one the values were
    // validated against. The service made the same comparison a moment ago and
    // this is not redundant: between its read and this one, a reconfiguration
    // could have landed, and writing then would store answers checked against a
    // schema this row does not point at.
    if (current.versionNumber !== draft.categoryVersionNumber) {
      throw new CategoryChangedError(
        draft.categorySlug,
        draft.categoryVersionNumber,
        current.versionNumber,
      );
    }

    const listing = await this.prisma.listing.create({
      data: {
        ownerId: draft.ownerId,
        // Both halves of the composite foreign key, resolved from one read so
        // they cannot disagree. The database refuses the pair if they ever do.
        categoryId: category.id,
        categoryVersionId: current.id,
        title: draft.title,
        description: draft.description,
        replacementValueAmount: draft.replacementValue.amount,
        replacementValueCurrency: draft.replacementValue.currency,
        attributes: draft.attributes,
        transportRequirement: draft.transportRequirement,
        requiresTwoPersonLift: draft.requiresTwoPersonLift,
        status: DRAFT,
      },
      include: LISTING_CATEGORY,
    });

    return toRecord(listing);
  }

  async findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null> {
    // The owner is part of the *query*, not a check applied to the result. A
    // read that fetches first and compares afterwards is one somebody later
    // refactors into a read that forgets to compare.
    const listing = await this.prisma.listing.findFirst({
      where: { id, ownerId },
      include: LISTING_CATEGORY,
    });

    return listing === null ? null : toRecord(listing);
  }

  async listOptions(): Promise<readonly CategoryOptionRecord[]> {
    const categories = await this.prisma.category.findMany({
      orderBy: { createdAt: 'asc' },
      include: LATEST_VERSION,
    });

    return categories.flatMap((category) => {
      const current = category.versions[0];
      // A category with no version has no name to show. Skipped rather than
      // thrown: this list is a form control, and one malformed row should not
      // stop somebody listing an item in a different category.
      return current === undefined ? [] : [toOption(category.slug, current)];
    });
  }

  async findOption(slug: string): Promise<CategoryOptionRecord | null> {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: LATEST_VERSION,
    });
    if (category === null) return null;

    const current = category.versions[0];
    // Null rather than the skip `listOptions` performs. There, one broken row
    // must not break a list of nine good ones; here the caller asked for this
    // category specifically, and "it has no configuration" and "it does not
    // exist" lead to the same honest answer.
    return current === undefined ? null : toOption(category.slug, current);
  }
}

const DRAFT: ListingStatus = 'DRAFT';

/** The current configuration: highest version number, one row. */
const LATEST_VERSION = {
  versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
} as const;

/**
 * The listing's category, reached through the pinned version.
 *
 * Through the version rather than a second relation to `Category`, because the
 * version is what the composite foreign key guarantees. Joining to the category
 * directly would work and would be a second path to the same fact.
 */
const LISTING_CATEGORY = {
  categoryVersion: { include: { category: true } },
} as const;

interface VersionRow {
  name: string;
  versionNumber: number;
  attributes: unknown;
  transportOptions: unknown;
}

function toOption(slug: string, version: VersionRow): CategoryOptionRecord {
  return {
    slug,
    name: version.name,
    attributes: asAttributes(version.attributes, `category "${slug}"`),
    transportOptions: asTransportOptions(
      version.transportOptions,
      `category "${slug}"`,
    ),
    versionNumber: version.versionNumber,
  };
}

interface ListingRow {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  replacementValueAmount: number;
  replacementValueCurrency: string;
  attributes: unknown;
  transportRequirement: string | null;
  requiresTwoPersonLift: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  categoryVersion: VersionRow & {
    category: { slug: string };
  };
}

function toRecord(listing: ListingRow): ListingRecord {
  return {
    id: listing.id,
    ownerId: listing.ownerId,
    categorySlug: listing.categoryVersion.category.slug,
    categoryName: listing.categoryVersion.name,
    categoryVersionNumber: listing.categoryVersion.versionNumber,
    categoryAttributes: asAttributes(
      listing.categoryVersion.attributes,
      `the category version pinned by listing ${listing.id}`,
    ),
    title: listing.title,
    description: listing.description,
    replacementValue: asMoney(
      listing.replacementValueAmount,
      listing.replacementValueCurrency,
      listing.id,
    ),
    attributes: asValues(listing.attributes, listing.id),
    transportRequirement: asRequirement(listing.transportRequirement, listing.id),
    requiresTwoPersonLift: listing.requiresTwoPersonLift,
    status: asStatus(listing.status),
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}

/**
 * Two columns become one value here, and the validation is not ceremony.
 *
 * `Money.money` refuses a non-integer and an unsupported currency, which is the
 * only thing standing between a row written by some future migration and an
 * amount that silently becomes a float on its way to a card. §8.7.1 turns this
 * number into money held on somebody's card, so reading it loosely is the wrong
 * kind of forgiving.
 */
function asMoney(amount: number, currency: string, listingId: string): MoneyValue {
  try {
    return Money.money(amount, currency as MoneyValue['currency']);
  } catch (error) {
    throw new Error(
      `Listing ${listingId} has a replacement value this build cannot read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * The stored schema, parsed on the way out.
 *
 * The same treatment the admin store gives it, and for the same reason: JSONB
 * checks that a value is JSON and cannot check that it is a schema this build
 * can render. A stored type this version does not know means a listing form that
 * would silently omit a configured field, and failing loudly is the better of
 * the two outcomes.
 */
function asAttributes(raw: unknown, what: string): readonly CategoryAttribute[] {
  try {
    return parseCategoryAttributes(raw);
  } catch (error) {
    throw new Error(
      `The attribute schema on ${what} is not one this build can read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * The stored answers, shape-checked on the way out.
 *
 * **Shape only — not conformance to the schema.** Whether an answer was legal
 * was settled against the pinned schema when it was written, and re-deciding it
 * here would mean a category change could make an existing listing unreadable
 * rather than merely outdated, which is the whole thing pinning exists to
 * prevent.
 *
 * What is checked is that the JSON is a set of answers at all. Only our
 * validated path writes here, so a failure means a hand-edited row or a
 * migration bug — and reading that as "no answers" would present somebody's
 * filled-in listing as empty.
 */
function asValues(raw: unknown, listingId: string): ListingAttributeValues {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Listing ${listingId} has attribute values that are not an object`);
  }

  const values: Record<string, string | number | readonly string[]> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number') {
      values[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      values[key] = value as readonly string[];
      continue;
    }
    throw new Error(
      `Listing ${listingId} has an attribute value for "${key}" that this build cannot read`,
    );
  }

  return values;
}

/**
 * A category's offered transport options, on the way out of `jsonb`.
 *
 * Throws rather than falling back to an empty selection, for the reason the
 * admin store gives: reading it as "none" would present the category as not
 * asking how its items are collected, and the listing form would silently stop
 * asking — §8.3's failed handover, arriving through a parse failure nobody sees.
 */
function asTransportOptions(
  raw: unknown,
  what: string,
): readonly CategoryTransportOption[] {
  try {
    return parseCategoryTransportOptions(raw);
  } catch (error) {
    throw new Error(
      `The transport options on ${what} are not ones this build can read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * The stored requirement, on the way out.
 *
 * Null is a real value here — a draft that has not said (§8.3) — and is passed
 * through rather than treated as missing.
 *
 * A value outside the vocabulary throws, for `asStatus`' reason. It means the
 * row was written by a newer build, and the two lenient readings are both wrong:
 * null would present an owner's stated requirement as unanswered, and passing it
 * through would put an unrenderable value in front of a renter deciding whether
 * they can collect the thing.
 *
 * **It deliberately does not check that the category still offers it.** That is
 * settled on the way in, against the pinned version; re-deciding it here would
 * mean withdrawing an option makes existing listings unreadable, which is what
 * pinning exists to prevent (ADR 0029).
 */
function asRequirement(
  value: string | null,
  listingId: string,
): TransportRequirement | null {
  if (value === null) return null;
  if ((TRANSPORT_REQUIREMENTS as readonly string[]).includes(value)) {
    return value as TransportRequirement;
  }
  throw new Error(
    `Listing ${listingId} has a transport requirement this build does not know: ${value}`,
  );
}

/**
 * The same treatment `riskLevel` gets in the category store.
 *
 * A status this build does not know means the row was written by a newer version
 * of the application. Reading it as `DRAFT` would present somebody's published
 * listing as unpublished, and — from slice 2.8 — would offer to publish
 * something that already is.
 */
function asStatus(value: string): ListingStatus {
  if ((LISTING_STATUSES as readonly string[]).includes(value)) {
    return value as ListingStatus;
  }
  throw new Error(`Unknown listing status in the database: ${value}`);
}
