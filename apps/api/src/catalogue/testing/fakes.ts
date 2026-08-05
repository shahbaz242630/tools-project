/**
 * Test doubles for the catalogue module.
 *
 * Behavioural, not recording spies. The rule this file exists to obey is the
 * one that has now bitten four times: **when a double stands in for a table
 * with a constraint, mirror the constraint.** `category_versions` carries two
 * that matter, and a double enforcing neither would let tests pass for
 * situations that cannot occur against Postgres:
 *
 *   - the unique slug, which is what makes a duplicate a 409 rather than a
 *     second category nobody can address; and
 *   - unique `(categoryId, versionNumber)`, which is the concurrency control —
 *     two administrators saving at once must not both succeed.
 *
 * Immutability needs no enforcement here because it is structural: versions are
 * appended to an array and nothing in this file writes to an existing element,
 * exactly as the real store issues no `UPDATE`.
 */

import { Time } from '@platform/core';
import type {
  CategoryAttribute,
  CategoryReportableActivity,
  CategoryRiskLevel,
  CategoryTransportOption,
} from '@platform/contracts';
import { CategorySlugTakenError } from '../category-store.js';
import { CategoryChangedError, UnknownCategoryError } from '../listing-store.js';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  ListingDraft,
  ListingRecord,
  ListingStore,
} from '../listing-store.js';
import { ListingsService } from '../listings.service.js';
import type {
  CategoryConfiguration,
  CategoryRecord,
  CategoryStore,
} from '../category-store.js';
import { CatalogueService } from '../catalogue.service.js';
import { createAuditFakes } from '../../audit/testing/fakes.js';
import type { AuditFakes } from '../../audit/testing/fakes.js';

interface StoredVersion {
  readonly versionNumber: number;
  readonly name: string;
  readonly riskLevel: CategoryRiskLevel;
  readonly reportableActivity: CategoryReportableActivity;
  readonly attributes: readonly CategoryAttribute[];
  readonly transportOptions: readonly CategoryTransportOption[];
  readonly createdById: string;
  readonly createdAt: Date;
}

interface StoredCategory {
  readonly id: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly versions: StoredVersion[];
}

/**
 * Raised when a version number is reused.
 *
 * Postgres raises a unique violation; this raises something a test can name. It
 * exists so the concurrency story can be exercised at all — without it, the
 * second of two simultaneous edits would quietly win here and fail only in
 * production.
 */
export class DuplicateVersionError extends Error {
  constructor(slug: string, versionNumber: number) {
    super(`Version ${String(versionNumber)} of "${slug}" already exists`);
    this.name = 'DuplicateVersionError';
  }
}

export class InMemoryCategoryStore implements CategoryStore {
  private readonly categories: StoredCategory[] = [];
  private nextId = 1;

  create(
    input: CategoryConfiguration & { readonly slug: string },
    authorId: string,
  ): Promise<CategoryRecord> {
    if (this.categories.some((category) => category.slug === input.slug)) {
      return Promise.reject(new CategorySlugTakenError(input.slug));
    }

    const stored: StoredCategory = {
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`,
      slug: input.slug,
      createdAt: Time.nowUtc(),
      versions: [
        {
          versionNumber: 1,
          name: input.name,
          riskLevel: input.riskLevel,
          reportableActivity: input.reportableActivity,
          // Copied, not referenced. The real store round-trips through JSONB, so
          // a caller that mutates its own array afterwards cannot reach back and
          // rewrite a stored version — and a double that shared the reference
          // would make an immutability test pass for the wrong reason.
          attributes: [...input.attributes],
          transportOptions: [...input.transportOptions],
          createdById: authorId,
          createdAt: Time.nowUtc(),
        },
      ],
    };

    this.categories.push(stored);
    return Promise.resolve(toRecord(stored));
  }

  addVersion(
    slug: string,
    configuration: CategoryConfiguration,
    authorId: string,
  ): Promise<CategoryRecord | null> {
    const category = this.categories.find((candidate) => candidate.slug === slug);
    if (category === undefined) return Promise.resolve(null);

    const next = current(category).versionNumber + 1;
    if (category.versions.some((version) => version.versionNumber === next)) {
      return Promise.reject(new DuplicateVersionError(slug, next));
    }

    category.versions.push({
      versionNumber: next,
      name: configuration.name,
      riskLevel: configuration.riskLevel,
      reportableActivity: configuration.reportableActivity,
      attributes: [...configuration.attributes],
      transportOptions: [...configuration.transportOptions],
      createdById: authorId,
      createdAt: Time.nowUtc(),
    });

    return Promise.resolve(toRecord(category));
  }

  list(): Promise<readonly CategoryRecord[]> {
    // Insertion order, which is the real store's `createdAt asc` — several
    // categories created in the same millisecond would sort arbitrarily by
    // clock, and a test creating three in a row does exactly that.
    return Promise.resolve(this.categories.map(toRecord));
  }

  findBySlug(slug: string): Promise<CategoryRecord | null> {
    const category = this.categories.find((candidate) => candidate.slug === slug);
    return Promise.resolve(category === undefined ? null : toRecord(category));
  }

  /** Every version of one category, oldest first — for asserting history. */
  versionsOf(slug: string): readonly StoredVersion[] {
    const category = this.categories.find((candidate) => candidate.slug === slug);
    return category === undefined ? [] : [...category.versions];
  }
}

function current(category: StoredCategory): StoredVersion {
  const latest = category.versions.at(-1);
  if (latest === undefined) {
    throw new Error(`Category ${category.slug} has no configuration version`);
  }
  return latest;
}

function toRecord(category: StoredCategory): CategoryRecord {
  const latest = current(category);
  return {
    id: category.id,
    slug: category.slug,
    name: latest.name,
    riskLevel: latest.riskLevel,
    reportableActivity: latest.reportableActivity,
    attributes: latest.attributes,
    transportOptions: latest.transportOptions,
    versionNumber: latest.versionNumber,
    versionCreatedAt: latest.createdAt,
    createdAt: category.createdAt,
  };
}

/** The owner-facing projection of a category: what to pick, and what it asks for. */
function toOption(category: CategoryRecord): CategoryOptionRecord {
  return {
    slug: category.slug,
    name: category.name,
    attributes: category.attributes,
    versionNumber: category.versionNumber,
  };
}

export interface CatalogueFakes {
  readonly store: InMemoryCategoryStore;
  readonly audit: AuditFakes;
  readonly service: CatalogueService;
}

export function createCatalogueFakes(): CatalogueFakes {
  const store = new InMemoryCategoryStore();
  const audit = createAuditFakes();
  return { store, audit, service: new CatalogueService(store, audit.service) };
}

/**
 * Listings, in memory, backed by the same category store the test already has.
 *
 * Sharing the category store is not convenience — it is the constraint. In
 * Postgres a listing's `(categoryVersionId, categoryId)` pair is a composite
 * foreign key against `category_versions`, so a listing cannot exist for a
 * category that does not, nor pin a version belonging to a different category. A
 * double that invented its own categories could produce both of those states and
 * let a test pass for a situation the database refuses.
 */
export class InMemoryListingStore implements ListingStore, CategoryOptionSource {
  private readonly listings: ListingRecord[] = [];
  private nextId = 1;

  constructor(private readonly categories: InMemoryCategoryStore) {}

  async createDraft(draft: ListingDraft): Promise<ListingRecord> {
    const category = await this.categories.findBySlug(draft.categorySlug);
    if (category === null) throw new UnknownCategoryError(draft.categorySlug);

    // The version about to be pinned, checked against the one the values were
    // validated against — the guarantee the real store makes inside its write.
    // Mirrored here for the reason this whole file exists: a double that skipped
    // it would let a test pass for a state Postgres and the adapter refuse.
    if (category.versionNumber !== draft.categoryVersionNumber) {
      throw new CategoryChangedError(
        draft.categorySlug,
        draft.categoryVersionNumber,
        category.versionNumber,
      );
    }

    const now = Time.nowUtc();
    const listing: ListingRecord = {
      id: `00000000-0000-4000-9000-${String(this.nextId++).padStart(12, '0')}`,
      ownerId: draft.ownerId,
      // Resolved together from one read, exactly as the real store does — the
      // pair is consistent by construction rather than by a check.
      categorySlug: category.slug,
      categoryName: category.name,
      categoryVersionNumber: category.versionNumber,
      categoryAttributes: category.attributes,
      title: draft.title,
      description: draft.description,
      replacementValue: draft.replacementValue,
      // Copied for the same reason the category store copies its schema: the
      // real store round-trips through JSONB, so a caller mutating its own
      // object afterwards must not be able to rewrite what was stored.
      attributes: { ...draft.attributes },
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
    };

    this.listings.push(listing);
    return listing;
  }

  findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null> {
    const listing = this.listings.find(
      (candidate) => candidate.id === id && candidate.ownerId === ownerId,
    );
    return Promise.resolve(listing ?? null);
  }

  async listOptions(): Promise<readonly CategoryOptionRecord[]> {
    const categories = await this.categories.list();
    return categories.map(toOption);
  }

  async findOption(slug: string): Promise<CategoryOptionRecord | null> {
    const category = await this.categories.findBySlug(slug);
    return category === null ? null : toOption(category);
  }

  /** Everything stored, for asserting that a refused write left nothing behind. */
  all(): readonly ListingRecord[] {
    return [...this.listings];
  }
}

export interface ListingFakes {
  readonly categories: InMemoryCategoryStore;
  readonly listings: InMemoryListingStore;
  readonly service: ListingsService;
}

/**
 * A listings service with its own category store.
 *
 * Takes an existing store when the test also needs the *admin* category surface,
 * so both talk about the same categories — a test that created a category
 * through `CatalogueService` and then could not list it as an option would be
 * testing two disconnected worlds.
 */
export function createListingFakes(
  categories: InMemoryCategoryStore = new InMemoryCategoryStore(),
): ListingFakes {
  const listings = new InMemoryListingStore(categories);
  return { categories, listings, service: new ListingsService(listings, listings) };
}
