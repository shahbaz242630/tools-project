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
import { createRecordingLogger } from '@platform/observability/testing';
import type { RecordingLogger } from '@platform/observability/testing';
import { LocationService } from '../../search-location/location.service.js';
import { FakeGeocoder } from '../../search-location/testing/fakes.js';
import type {
  CategoryAttribute,
  CategoryFeePolicy,
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
  readonly feePolicy: CategoryFeePolicy;
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
          feePolicy: input.feePolicy,
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
      feePolicy: configuration.feePolicy,
      createdById: authorId,
      createdAt: Time.nowUtc(),
    });

    return Promise.resolve(toRecord(category));
  }

  list(limit: number): Promise<readonly CategoryRecord[]> {
    // Insertion order, which is the real store's `createdAt asc` — several
    // categories created in the same millisecond would sort arbitrarily by
    // clock, and a test creating three in a row does exactly that.
    //
    // **The limit is honoured, not ignored** (slice H2). A double that returned
    // everything would let a truncation test pass with no `take` in the real
    // adapter at all, which is the bug the slice exists to fix.
    return Promise.resolve(this.categories.slice(0, limit).map(toRecord));
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
    feePolicy: latest.feePolicy,
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
    transportOptions: category.transportOptions,
    versionNumber: category.versionNumber,
  };
}

export interface CatalogueFakes {
  readonly store: InMemoryCategoryStore;
  readonly audit: AuditFakes;
  /** For asserting that a bound firing is reported rather than silent (H2). */
  readonly logger: RecordingLogger;
  readonly service: CatalogueService;
}

export function createCatalogueFakes(): CatalogueFakes {
  const store = new InMemoryCategoryStore();
  const audit = createAuditFakes();
  const logger = createRecordingLogger();
  return {
    store,
    audit,
    logger,
    service: new CatalogueService(store, audit.service, logger.logger),
  };
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
      // The policy on the version being pinned, resolved from the same read as
      // the schema — so a test cannot produce a listing priced under one
      // version's rates while claiming another's.
      categoryFeePolicy: category.feePolicy,
      categoryTransportOptions: category.transportOptions,
      title: draft.title,
      description: draft.description,
      replacementValue: draft.replacementValue,
      rates: draft.rates,
      // Copied for the same reason the category store copies its schema: the
      // real store round-trips through JSONB, so a caller mutating its own
      // object afterwards must not be able to rewrite what was stored.
      attributes: { ...draft.attributes },
      transportRequirement: draft.transportRequirement,
      requiresTwoPersonLift: draft.requiresTwoPersonLift,
      // Copied rather than referenced, for the reason the attributes are: the
      // real store round-trips this through two tables and a cipher, so a
      // caller holding on to its own object must not be able to rewrite what
      // was stored.
      collectionLocation:
        draft.collectionLocation === null ? null : { ...draft.collectionLocation },
      // A boolean, mirroring the real store: nothing above the store ever sees
      // the coordinates, so a double that exposed them would let a test assert
      // something production cannot do.
      isLocated: draft.locatedPoint !== null,
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

  publish(id: string, ownerId: string): Promise<ListingRecord | null> {
    const index = this.listings.findIndex(
      (listing) => listing.id === id && listing.ownerId === ownerId,
    );
    if (index === -1) return Promise.resolve(null);

    const listing = this.listings[index];
    /* c8 ignore next */
    if (listing === undefined) return Promise.resolve(null);

    // Idempotent, and the record is replaced rather than mutated so a caller
    // holding an earlier one does not see it change underneath them — the real
    // store re-reads, which has the same effect.
    const published: ListingRecord = {
      ...listing,
      status: 'PUBLISHED',
      updatedAt: Time.nowUtc(),
    };
    this.listings[index] = published;
    return Promise.resolve(published);
  }

  pause(id: string, ownerId: string): Promise<ListingRecord | null> {
    const index = this.listings.findIndex(
      (listing) => listing.id === id && listing.ownerId === ownerId,
    );
    if (index === -1) return Promise.resolve(null);

    const listing = this.listings[index];
    /* c8 ignore next */
    if (listing === undefined) return Promise.resolve(null);

    // `publish`'s shape: idempotent, and replacing the record rather than
    // mutating it, because the real store re-reads and hands back a new one.
    //
    // **It does not check the current status**, exactly as the real query does
    // not put one in its `where`. A double that refused to pause a draft would
    // hide a missing check in the service — the legality of the transition is
    // the service's to enforce, and a test proving it does so has to be able to
    // reach a store that would have allowed it.
    const paused: ListingRecord = {
      ...listing,
      status: 'PAUSED',
      updatedAt: Time.nowUtc(),
    };
    this.listings[index] = paused;
    return Promise.resolve(paused);
  }

  listOwnedBy(ownerId: string, limit: number): Promise<readonly ListingRecord[]> {
    // Newest first, matching the real store's `orderBy` and the index behind
    // it. A double that returned insertion order would let a test pass while
    // the dashboard in 2.9 showed the oldest listing at the top.
    //
    // **The limit is applied after the sort**, as `take` is in the real query.
    // Slicing first would keep the oldest rows and drop the newest, which is
    // the opposite of what the export should cut.
    return Promise.resolve(
      this.listings
        .filter((listing) => listing.ownerId === ownerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit),
    );
  }

  /**
   * Delete the listings outright — the real store's behaviour since 2.8b.
   *
   * **This double used to keep the listing and clear its address**, which was
   * right when the real store did that. Changing it in step matters more than it
   * looks: a fake that still cleared an address and kept the row would let an
   * erasure test pass while the real system deleted rows, and the two would only
   * disagree in a db test nobody had thought to write.
   */
  deleteAllOwnedBy(ownerId: string): Promise<void> {
    // Spliced in place rather than reassigned, because the array is `readonly`
    // — the field, not its contents — and because a test holding a reference to
    // it should see the same emptying the store sees.
    const survivors = this.listings.filter((listing) => listing.ownerId !== ownerId);
    this.listings.splice(0, this.listings.length, ...survivors);
    return Promise.resolve();
  }

  async listOptions(limit: number): Promise<readonly CategoryOptionRecord[]> {
    const categories = await this.categories.list(limit);
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
  /** Seed it with `knows(...)` for a test that needs a listing to be locatable. */
  readonly geocoder: FakeGeocoder;
  /** For asserting that a bound firing is reported rather than silent (H2). */
  readonly logger: RecordingLogger;
  /**
   * The publication kill switch (slice H3a).
   *
   * **Defaults to on**, matching the flag's declared default, so every test
   * written before H3a still describes a platform that can publish. A double
   * defaulting to off would have made the switch's arrival look like a hundred
   * unrelated regressions.
   */
  readonly publication: SwitchableFlag;
  readonly service: ListingsService;
}

/** A kill switch a test can throw, standing in for the flags module. */
export class SwitchableFlag {
  private enabled = true;

  off(): this {
    this.enabled = false;
    return this;
  }

  on(): this {
    this.enabled = true;
    return this;
  }

  isPublicationEnabled(): Promise<boolean> {
    return Promise.resolve(this.enabled);
  }
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
  // A real `LocationService` over a fake geocoder, rather than a stub locator.
  // The fuzz is the part worth exercising — a stubbed locator would let a test
  // pass with the offset never drawn, which is the one thing §8.4.1 requires.
  const geocoder = new FakeGeocoder();
  const logger = createRecordingLogger();
  const location = new LocationService(geocoder, logger.logger);

  const publication = new SwitchableFlag();

  return {
    categories,
    listings,
    geocoder,
    logger,
    publication,
    service: new ListingsService(
      listings,
      listings,
      { locate: (postcode) => location.locate(postcode) },
      logger.logger,
      publication,
    ),
  };
}
