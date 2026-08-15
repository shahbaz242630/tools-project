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

import { DEFAULT_MODERATION_STATE, isPubliclyVisible } from '@platform/contracts';
import { Postcode, Time } from '@platform/core';
import {
  createRecordingLogger,
  createRecordingMetrics,
} from '@platform/observability/testing';
import type {
  RecordingLogger,
  RecordingMetrics,
} from '@platform/observability/testing';
import { LocationService } from '../../search-location/location.service.js';
import {
  FakeGeocoder,
  FakeListingSearch,
} from '../../search-location/testing/fakes.js';
import type {
  CategoryAttribute,
  CategoryFeePolicy,
  CategoryReportableActivity,
  CategoryRiskLevel,
  CategoryTransportOption,
  PublicCategory,
} from '@platform/contracts';
import { CategorySlugTakenError } from '../category-store.js';
import { CategoryChangedError, UnknownCategoryError } from '../listing-store.js';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  CollectionLocationEdit,
  ListingDraft,
  ListingEdit,
  ListingRecord,
  ListingStore,
  ModerationDecision,
  PublicListingRecord,
  PublicListingSummaryRecord,
} from '../listing-store.js';
import type { LocatedListingPoint, StoredFuzzOffset } from '../listing-locator.js';
import type { OwnerStatus } from '@platform/contracts';
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
  /**
   * The fuzz offsets, beside the listings rather than on them (slice 2.9b-ii).
   *
   * **A second structure because `ListingRecord` deliberately has no room for
   * one**, which is the real store's arrangement too: the offset lives in
   * `listing_locations` and comes back only through `findFuzzOffset`. A double
   * that hung it off the record would let a test reach it by a route production
   * does not have, and the test asserting the offset survives an edit is the
   * whole point of the slice — it has to go the way the service goes.
   */
  private readonly offsets = new Map<string, StoredFuzzOffset>();
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
      // A placeholder, overwritten by `hydrate` on the way out of every read
      // (ADR 0042). It is stored at all only because `ListingRecord` requires
      // the field; the value that matters is resolved when the listing is
      // *read*, because a fee policy changes underneath a listing nobody has
      // touched and a value captured here would freeze it.
      currentFeePolicy: category.feePolicy,
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
      // The column's default, mirrored here. A double that started listings at
      // `UNDER_REVIEW` would make every publication test pass through a queue
      // that does not exist (ADR 0041).
      moderationState: DEFAULT_MODERATION_STATE,
      moderationReason: null,
      createdAt: now,
      updatedAt: now,
    };

    this.listings.push(listing);
    this.rememberOffset(listing.id, draft.locatedPoint);
    return this.hydrate(listing);
  }

  /**
   * Keep — or forget — a listing's offset, mirroring the six columns that hold it.
   *
   * All six together or none, which is `location_is_geocoded_or_not` restated: a
   * point means an offset, and no point means no offset. A double that kept a
   * stale offset after the coordinates went would let the service's "draw a new
   * one only when there is none" branch pass a test it should fail.
   */
  private rememberOffset(listingId: string, point: LocatedListingPoint | null): void {
    if (point === null) {
      this.offsets.delete(listingId);
      return;
    }

    this.offsets.set(listingId, {
      bearingDegrees: point.fuzzBearingDegrees,
      distanceMetres: point.fuzzDistanceMetres,
    });
  }

  async findFuzzOffset(id: string, ownerId: string): Promise<StoredFuzzOffset | null> {
    // Owner-scoped through the same read the real adapter joins through, so a
    // test cannot pass by asking for a stranger's offset.
    const listing = await this.findOwnedBy(id, ownerId);
    if (listing === null) return null;

    return this.offsets.get(id) ?? null;
  }

  /**
   * What an edit does to the stored location, on the record and in the offsets
   * (slice 2.9b-ii).
   *
   * The three cases the real adapter switches on, with the one that matters
   * reproduced faithfully: **`address-only` does not touch the offset**, so a
   * test that saves the same address twice and finds the offset changed is
   * looking at a real defect rather than at this double.
   */
  private editedLocation(
    listing: ListingRecord,
    edit: CollectionLocationEdit,
  ): Pick<ListingRecord, 'collectionLocation' | 'isLocated'> {
    if (edit.kind === 'cleared') {
      this.offsets.delete(listing.id);
      return { collectionLocation: null, isLocated: false };
    }

    if (edit.kind === 'address-only') {
      // The offset and `isLocated` are carried over deliberately — this case is
      // only reached for a listing that is already located.
      return {
        collectionLocation: { ...edit.location },
        isLocated: listing.isLocated,
      };
    }

    this.rememberOffset(listing.id, edit.point);
    return {
      collectionLocation: { ...edit.location },
      isLocated: edit.point !== null,
    };
  }

  /**
   * Attach the category's **current** fee policy (ADR 0042).
   *
   * **Every read goes through this, and that is the point of it existing rather
   * than each read doing it.** The real adapter resolves the latest version in
   * its `include`, so a double that returned a policy captured at creation would
   * let a test prove the opposite of production: that reconfiguring a category's
   * fees leaves an existing listing's price alone. It does not, deliberately.
   *
   * The stored record keeps its *pinned* attributes and transport options
   * untouched, which is the other half of 0042 — the schema a value was written
   * against must not move, and the price must.
   */
  private async hydrate(listing: ListingRecord): Promise<ListingRecord> {
    const category = await this.categories.findBySlug(listing.categorySlug);

    /* c8 ignore next -- unreachable: a listing cannot exist without its category,
       and nothing deletes one. Mirrors `latestVersionOf`'s fallback in the real
       adapter, which is unreachable for the same reason. */
    if (category === null) return listing;

    return { ...listing, currentFeePolicy: category.feePolicy };
  }

  async findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null> {
    const listing = this.listings.find(
      (candidate) => candidate.id === id && candidate.ownerId === ownerId,
    );
    return listing === undefined ? null : this.hydrate(listing);
  }

  /**
   * The public read (slice 2.10).
   *
   * **The double calls `isPubliclyVisible` where the real store restates it in
   * SQL**, and the asymmetry is deliberate rather than laziness. The adapter has
   * to express the rule as two columns because Phase 3 needs an index; here
   * there is no such constraint, so it uses the function — which means a test
   * against this double is testing the *rule*, and the db test walking all nine
   * status × moderation pairs is what proves the SQL agrees with it.
   *
   * **It builds `PublicListingRecord` field by field rather than spreading**,
   * for the reason 2.9a built `OwnerListingSummary` that way: a spread with
   * deletions is a projection that silently gains whatever the source record
   * gains next, and what this one would gain is a decrypted street address.
   */
  async findPublished(id: string): Promise<PublicListingRecord | null> {
    const listing = this.listings.find((candidate) => candidate.id === id);
    if (listing === undefined) return null;
    if (!isPubliclyVisible(listing.status, listing.moderationState)) return null;

    const location = listing.collectionLocation;
    /* c8 ignore next -- publication refuses a listing with no address. */
    if (location === null) return null;

    const hydrated = await this.hydrate(listing);

    return {
      id: hydrated.id,
      ownerId: hydrated.ownerId,
      categorySlug: hydrated.categorySlug,
      categoryName: hydrated.categoryName,
      categoryAttributes: hydrated.categoryAttributes,
      currentFeePolicy: hydrated.currentFeePolicy,
      title: hydrated.title,
      description: hydrated.description,
      rates: hydrated.rates,
      attributes: { ...hydrated.attributes },
      transportRequirement: hydrated.transportRequirement,
      requiresTwoPersonLift: hydrated.requiresTwoPersonLift,
      // Derived from the postcode exactly as the real adapter derives the
      // column on write, so a test cannot pass with a district the production
      // path would never have stored.
      outwardCode: Postcode.outwardCode(location.postcode),
      town: location.town,
    };
  }

  /**
   * The bulk public read search hydrates from (slice 3.1a).
   *
   * **It applies `isPubliclyVisible` again**, exactly as the real adapter
   * repeats `PUBLICLY_VISIBLE` — the ids came from a different query, and a
   * double that trusted them would let a test pass for a listing the production
   * path would have dropped.
   *
   * **Returns in no particular order, and a test relying on one is testing this
   * file rather than the system.** The service is what orders results, from
   * distances this method cannot see.
   */
  async findPublishedSummaries(
    ids: readonly string[],
  ): Promise<readonly PublicListingSummaryRecord[]> {
    const wanted = new Set(ids);
    const summaries: PublicListingSummaryRecord[] = [];

    for (const listing of this.listings) {
      if (!wanted.has(listing.id)) continue;
      if (!isPubliclyVisible(listing.status, listing.moderationState)) continue;

      const location = listing.collectionLocation;
      /* c8 ignore next -- publication refuses a listing with no address. */
      if (location === null) continue;

      const hydrated = await this.hydrate(listing);

      summaries.push({
        id: hydrated.id,
        ownerId: hydrated.ownerId,
        categoryName: hydrated.categoryName,
        currentFeePolicy: hydrated.currentFeePolicy,
        title: hydrated.title,
        rates: hydrated.rates,
        outwardCode: Postcode.outwardCode(location.postcode),
        town: location.town,
      });
    }

    return summaries;
  }

  async update(
    id: string,
    ownerId: string,
    edit: ListingEdit,
  ): Promise<ListingRecord | null> {
    const index = this.listings.findIndex(
      (listing) => listing.id === id && listing.ownerId === ownerId,
    );
    if (index === -1) return null;

    const listing = this.listings[index];
    /* c8 ignore next */
    if (listing === undefined) return null;

    const category = await this.categories.findBySlug(listing.categorySlug);
    /* c8 ignore next 2 -- unreachable: a listing cannot exist without its
       category, and nothing deletes one. */
    if (category === null) return null;

    // **The staleness guard the real store makes inside its write**, mirrored
    // for the reason this whole file exists: a double that skipped it would let
    // a test pass for a state the adapter refuses.
    if (category.versionNumber !== edit.categoryVersionNumber) {
      throw new CategoryChangedError(
        listing.categorySlug,
        edit.categoryVersionNumber,
        category.versionNumber,
      );
    }

    const updated: ListingRecord = {
      ...listing,
      title: edit.title,
      description: edit.description,
      replacementValue: edit.replacementValue,
      attributes: { ...edit.attributes },
      transportRequirement: edit.transportRequirement,
      requiresTwoPersonLift: edit.requiresTwoPersonLift,
      rates: edit.rates,
      // **Re-pinned**, which is ADR 0042's fourth point and the behaviour a test
      // most needs this double to reproduce: the name and schema move with the
      // version, so a listing edited after a rename reads under the new labels.
      categoryVersionNumber: category.versionNumber,
      categoryName: category.name,
      categoryAttributes: category.attributes,
      categoryTransportOptions: category.transportOptions,
      ...this.editedLocation(listing, edit.collectionLocation),
      // **Deliberately carried over untouched**: the status and the moderation
      // state. A double that cleared either would hide the very defect the real
      // method is written to avoid.
      updatedAt: Time.nowUtc(),
    };

    this.listings[index] = updated;
    return this.hydrate(updated);
  }

  async publish(id: string, ownerId: string): Promise<ListingRecord | null> {
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
    return this.hydrate(published);
  }

  async pause(id: string, ownerId: string): Promise<ListingRecord | null> {
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
    return this.hydrate(paused);
  }

  async listOwnedBy(ownerId: string, limit: number): Promise<readonly ListingRecord[]> {
    // Newest first, matching the real store's `orderBy` and the index behind
    // it. A double that returned insertion order would let a test pass while
    // the dashboard in 2.9 showed the oldest listing at the top.
    //
    // **The limit is applied after the sort**, as `take` is in the real query.
    // Slicing first would keep the oldest rows and drop the newest, which is
    // the opposite of what the export should cut.
    //
    // **The tiebreak is not decoration — it is the fix for a real flake.** Two
    // listings created in the same millisecond compare equal on `createdAt`, and
    // `Array.prototype.sort` is stable, so the *older* one stayed first and
    // "newest first" failed. It fired roughly one run in eight, always on a
    // diff that had nothing to do with it. Postgres does not have the problem
    // because each request is its own transaction and `now()` differs; this
    // double shares a process clock, so it needs the position it was inserted at
    // to stand in for that.
    const order = new Map(this.listings.map((listing, index) => [listing.id, index]));
    const insertedAt = (listing: ListingRecord) => order.get(listing.id) ?? 0;

    return Promise.all(
      this.listings
        .filter((listing) => listing.ownerId === ownerId)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            insertedAt(b) - insertedAt(a),
        )
        .slice(0, limit)
        // Hydrated per row, so every listing on the dashboard is priced under
        // the category's current policy rather than whichever one it pinned.
        .map((listing) => this.hydrate(listing)),
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
  async findForModeration(id: string): Promise<ListingRecord | null> {
    // No owner filter, exactly as the real one has none. A double that quietly
    // scoped by owner would let a moderation test pass while proving the
    // opposite of what it claims — that an administrator can reach a listing
    // that is not theirs.
    const listing = this.listings.find((candidate) => candidate.id === id);
    return listing === undefined ? null : this.hydrate(listing);
  }

  async moderate(input: ModerationDecision): Promise<ListingRecord | null> {
    const index = this.listings.findIndex((listing) => listing.id === input.listingId);
    if (index === -1) return Promise.resolve(null);

    const listing = this.listings[index];
    /* c8 ignore next */
    if (listing === undefined) return Promise.resolve(null);

    const moderated: ListingRecord = {
      ...listing,
      moderationState: input.state,
      // Replaced rather than merged, so returning to APPROVED clears the
      // sentence that took the listing down — the real adapter's behaviour, and
      // a stale reason is one 2.8c-ii would show to the owner.
      moderationReason: input.reason,
      updatedAt: Time.nowUtc(),
    };
    this.listings[index] = moderated;
    return this.hydrate(moderated);
  }

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

  /**
   * The slug's category id, or null (slice 3.2a).
   *
   * **It reads the same store `findOption` does, and returns only the id** — a
   * double that answered from a separate map could disagree with `createDraft`
   * about which categories exist, and the test asserting that a search filter
   * finds a listing would then be asserting nothing about the listing's actual
   * category.
   */
  async findCategoryId(slug: string): Promise<string | null> {
    const category = await this.categories.findBySlug(slug);
    return category?.id ?? null;
  }

  /**
   * Slug and name only (slice 3.2b).
   *
   * **Built rather than spread**, so the double cannot return a field the real
   * one does not — which is the failure that would matter here: a disclosure
   * test passing against a fake that happens to carry more than production does.
   */
  async listCategoryNames(limit: number): Promise<readonly PublicCategory[]> {
    const categories = await this.categories.list(limit);
    return categories.map((category) => ({
      slug: category.slug,
      name: category.name,
    }));
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
  /** For asserting the moderation entry, and that nothing else writes one. */
  readonly audit: AuditFakes;
  /**
   * Who has declared themselves a private owner or a business (slice 2.13).
   *
   * **Defaults to everybody being a private owner**, for the reason
   * `publication` defaults to on: every test written before 2.13 describes an
   * ordinary person listing their own lawnmower, and a double that answered
   * "has not declared" would have made one new blocker look like a hundred
   * unrelated regressions. The tests that are about it say so.
   */
  readonly ownerStatuses: DeclaredOwnerStatuses;
  /**
   * Which listings are near the origin (slice 3.1a).
   *
   * **Defaults to empty rather than to "everything is nearby"**, which is the
   * opposite default to `publication` and `ownerStatuses` above — and the
   * asymmetry is right. Those two stand in for facts that are true of an
   * ordinary platform, so defaulting them to permissive keeps old tests
   * describing an ordinary platform. This one stands in for geography, and there
   * is no ordinary answer: a test that has not placed a listing has not said
   * where anything is, and should see nothing rather than everything.
   */
  readonly proximity: FakeListingSearch;
  /**
   * What the service recorded about each search (slice 3.1f).
   *
   * Exposed rather than swallowed by a no-op, because the *absence* of a
   * recording is the failure this replaces: a search that finds nothing and a
   * geocoder that is down look identical from outside, so nothing but an
   * assertion on `listingSearches` can tell "counted as unplaceable" from
   * "counted as an empty area".
   */
  readonly metrics: RecordingMetrics;
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
 * How each owner has declared themselves (slice 2.13).
 *
 * **Defaults to `private_owner`, and that is the one place in this file a
 * default is the right call.** Every existing test in the suite predates the
 * declaration and describes an ordinary person listing their own lawnmower; if
 * this answered null they would all fail on a blocker they are not about, and
 * the signal from the tests that *are* about it would be lost in the noise.
 *
 * The tests that care set it explicitly — including `hasNotDeclared`, which is
 * the state every real new account starts in.
 */
export class DeclaredOwnerStatuses {
  private readonly declared = new Map<string, OwnerStatus | null>();
  private fallback: OwnerStatus | null = 'private_owner';

  /** Everybody who has not been named individually has not answered. */
  nobodyHasDeclared(): this {
    this.fallback = null;
    return this;
  }

  declares(userId: string, status: OwnerStatus): this {
    this.declared.set(userId, status);
    return this;
  }

  hasNotDeclared(userId: string): this {
    this.declared.set(userId, null);
    return this;
  }

  findOwnerStatus(userId: string): Promise<OwnerStatus | null> {
    return Promise.resolve(
      this.declared.has(userId) ? (this.declared.get(userId) ?? null) : this.fallback,
    );
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
  /**
   * Takes an existing audit fake for the reason it takes an existing category
   * store: moderation writes an entry (ADR 0041), and an integration test
   * asserting on the module's audit while this service wrote to its own would
   * be looking at two disconnected trails and concluding nothing was recorded.
   */
  audit: AuditFakes = createAuditFakes(),
): ListingFakes {
  const listings = new InMemoryListingStore(categories);
  // A real `LocationService` over a fake geocoder, rather than a stub locator.
  // The fuzz is the part worth exercising — a stubbed locator would let a test
  // pass with the offset never drawn, which is the one thing §8.4.1 requires.
  const geocoder = new FakeGeocoder();
  const logger = createRecordingLogger();
  const metrics = createRecordingMetrics();
  const location = new LocationService(geocoder, logger.logger, metrics.metrics);

  const publication = new SwitchableFlag();
  const ownerStatuses = new DeclaredOwnerStatuses();
  const proximity = new FakeListingSearch();

  return {
    categories,
    listings,
    geocoder,
    logger,
    publication,
    audit,
    ownerStatuses,
    proximity,
    metrics,
    service: new ListingsService(
      listings,
      listings,
      {
        locate: (postcode) => location.locate(postcode),
        // Both methods wired, so a test exercising an edit goes through the real
        // fuzz arithmetic rather than a stub that could not redraw an offset even
        // if the service asked it to — which is the thing under test.
        relocate: (postcode, offset) => location.relocate(postcode, offset),
      },
      logger.logger,
      publication,
      audit.service,
      ownerStatuses,
      proximity,
      // The same instance the `LocationService` above was given, so a test can
      // assert on the search outcome and the geocode in one place — which is
      // also how the real application is wired.
      metrics.metrics,
    ),
  };
}
