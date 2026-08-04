import type { PrismaClient } from '@platform/database';
import type { ListingStatus } from '@platform/contracts';
import { LISTING_STATUSES } from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import { Money } from '@platform/core';
import { UnknownCategoryError } from './listing-store.js';
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
      return current === undefined ? [] : [{ slug: category.slug, name: current.name }];
    });
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

interface ListingRow {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  replacementValueAmount: number;
  replacementValueCurrency: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  categoryVersion: {
    name: string;
    versionNumber: number;
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
    title: listing.title,
    description: listing.description,
    replacementValue: asMoney(
      listing.replacementValueAmount,
      listing.replacementValueCurrency,
      listing.id,
    ),
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
