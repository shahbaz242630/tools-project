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

import { randomUUID } from 'node:crypto';
import { DEFAULT_MODERATION_STATE, isPubliclyVisible } from '@platform/contracts';
import { Postcode, Time } from '@platform/core';
import { ObjectStoreUnavailableError } from '../object-store.js';
import { MemoryObjectStore } from '../memory-object-store.js';
import { ListingMediaService } from '../listing-media.service.js';
import { ListingImageSigner } from '../listing-image-signer.js';
import type {
  ListingMediaRecord,
  ListingMediaStore,
  NewListingMedia,
} from '../listing-media-store.js';
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
  DamageSecurityPolicy,
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
  PublicListingMediaRecord,
  PublicListingRecord,
  PublicListingSummaryRecord,
  QuotableListingRecord,
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
import { createBookingFakes } from '../../booking/testing/fakes.js';
import type { AuditFakes } from '../../audit/testing/fakes.js';

interface StoredVersion {
  /**
   * The version's own identity, which is what a listing and a booking pin.
   *
   * **Added in 5.2b, because settlement asks by it.** Everything before read
   * configuration through a slug and the *current* version; §8.2 makes
   * settlement ask about one exact row, so the double has to have one.
   */
  readonly id: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly riskLevel: CategoryRiskLevel;
  readonly reportableActivity: CategoryReportableActivity;
  readonly attributes: readonly CategoryAttribute[];
  readonly transportOptions: readonly CategoryTransportOption[];
  readonly feePolicy: CategoryFeePolicy;
  /** §8.7.2's excess band, or `null` for no security (slice 5.5a). */
  readonly damageSecurity: DamageSecurityPolicy | null;
  /** §8.5.3's cap, stored on the version like everything else (slice 4.4a). */
  readonly maximumRentalDays: number;
  readonly requestExpiryHours: number;
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
          id: versionIdFor(this.nextId - 1, 1),
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
          // What was configured, `null` included. A double that quietly dropped
          // a null band would make "a category may require no security" pass by
          // never being stored — the same failure the cap comment below names.
          damageSecurity: input.damageSecurity,
          // What was configured, not the default. A double that stored 88
          // whatever it was handed would make a category configured to 30 read
          // back as 88 — and every test of "the cap comes from configuration"
          // would pass while proving the opposite (slice 4.4a).
          maximumRentalDays: input.maximumRentalDays,
          requestExpiryHours: input.requestExpiryHours,
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
      id: versionIdFor(this.categories.indexOf(category) + 1, next),
      versionNumber: next,
      name: configuration.name,
      riskLevel: configuration.riskLevel,
      reportableActivity: configuration.reportableActivity,
      attributes: [...configuration.attributes],
      transportOptions: [...configuration.transportOptions],
      feePolicy: configuration.feePolicy,
      damageSecurity: configuration.damageSecurity,
      maximumRentalDays: configuration.maximumRentalDays,
      requestExpiryHours: configuration.requestExpiryHours,
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

  findFeePolicyByVersionId(
    categoryVersionId: string,
  ): Promise<CategoryFeePolicy | null> {
    for (const category of this.categories) {
      const version = category.versions.find(
        (candidate) => candidate.id === categoryVersionId,
      );
      // The pinned row, **not** the current one — which is the whole rule this
      // port exists for. A double that returned `current(category).feePolicy`
      // would make every §8.2 test pass while proving the opposite.
      if (version !== undefined) return Promise.resolve(version.feePolicy);
    }
    return Promise.resolve(null);
  }

  /** Every version of one category, oldest first — for asserting history. */
  versionsOf(slug: string): readonly StoredVersion[] {
    const category = this.categories.find((candidate) => candidate.slug === slug);
    return category === undefined ? [] : [...category.versions];
  }
}

/**
 * A stable, uuid-shaped id per (category, version).
 *
 * Shaped like a uuid rather than `version-1-2` because these ids reach code that
 * hands them to Postgres in the integration tests, and a `uuid` column refuses
 * anything else.
 */
function versionIdFor(categoryIndex: number, versionNumber: number): string {
  const tail = `${String(categoryIndex).padStart(6, '0')}${String(versionNumber).padStart(6, '0')}`;
  return `00000000-0000-4000-9000-${tail}`;
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
    damageSecurity: latest.damageSecurity,
    maximumRentalDays: latest.maximumRentalDays,
    requestExpiryHours: latest.requestExpiryHours,
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
  /**
   * Where this double reads photographs from (slice 2.6b-ii).
   *
   * **Set afterwards rather than taken in the constructor**, because the media
   * store is built *from* this one — `createListingMediaFakes` needs a listing
   * store to prove ownership against — so the two cannot both be constructor
   * arguments of each other.
   *
   * **Null means no media store is wired, not "no photographs".** A test that
   * never touches media gets empty projections, which is right; a test that
   * does gets the real rows, filtered and ordered the way the adapter does it.
   * Returning `[]` unconditionally would have made every assertion about
   * photographs on a public read pass without a photograph ever existing.
   */
  private media: InMemoryListingMediaStore | null = null;

  constructor(private readonly categories: InMemoryCategoryStore) {}

  /** Read photographs from this store on the two public projections. */
  useMedia(media: InMemoryListingMediaStore): void {
    this.media = media;
  }

  /**
   * This listing's approved photographs, in the order the adapter returns them.
   *
   * **The same three rules as `PUBLIC_LISTING_MEDIA`**, restated because a
   * double that skipped any of them would let the real one's absence pass:
   * `APPROVED` only, ordered by `(position, createdAt, id)`, and keys rather
   * than URLs.
   */
  private async publicMedia(
    listingId: string,
  ): Promise<readonly PublicListingMediaRecord[]> {
    if (this.media === null) return [];

    const rows = await this.media.listFor(listingId);

    return rows
      .filter((row) => row.moderationState === 'APPROVED')
      .map((row) => ({
        id: row.id,
        display: { key: row.displayKey, width: row.width, height: row.height },
        thumbnail: {
          key: row.thumbnailKey,
          width: row.thumbnailWidth,
          height: row.thumbnailHeight,
        },
      }));
  }

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
      // Beside the fee policy and from the same version, as the real store
      // resolves it — `hydrate` below keeps every later read in step.
      currentDamageSecurity: category.damageSecurity,
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

    /*
     * **The damage band is refreshed with the fee policy** (5.5b-ii), for the
     * reason this method exists at all: the real adapter resolves both from the
     * latest version on every read, so a double that refreshed one and froze the
     * other would let a test prove that reconfiguring a category's damage
     * security leaves an existing listing alone. It does not.
     */
    return {
      ...listing,
      currentFeePolicy: category.feePolicy,
      currentDamageSecurity: category.damageSecurity,
    };
  }

  async findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null> {
    const listing = this.listings.find(
      (candidate) => candidate.id === id && candidate.ownerId === ownerId,
    );
    return listing === undefined ? null : this.hydrate(listing);
  }

  ownerOf(id: string): Promise<string | null> {
    // Off the raw array, like `existsOwnedBy` below and for its reason: the real
    // adapter reads one column and never hydrates a record.
    const listing = this.listings.find((candidate) => candidate.id === id);
    return Promise.resolve(listing?.ownerId ?? null);
  }

  existsOwnedBy(id: string, ownerId: string): Promise<boolean> {
    // Answered off the raw array rather than through `findOwnedBy`, mirroring
    // the adapter's `select: { id: true }` — a double that hydrated the record
    // would hide the fact that the real one never reads an address (slice 4.3b).
    return Promise.resolve(
      this.listings.some(
        (candidate) => candidate.id === id && candidate.ownerId === ownerId,
      ),
    );
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
  /**
   * What the quote engine needs (slice 4.4b).
   *
   * **The same visibility check as `findPublished`**, called rather than
   * restated, so the double cannot drift from its neighbour the way the real
   * adapter's three SQL predicates could.
   *
   * **The version id is synthesised, and it has to be.** This double holds no
   * `category_versions` rows — a category is one object with a version *number* —
   * so there is no id to return. What a test needs of it is what production
   * guarantees: that it is stable for a given configuration and *changes when the
   * category is reconfigured*, which is what makes "the quote pinned the version
   * it priced under" provable here at all.
   */
  async findQuotable(id: string): Promise<QuotableListingRecord | null> {
    const listing = this.listings.find((candidate) => candidate.id === id);
    if (listing === undefined) return null;
    if (!isPubliclyVisible(listing.status, listing.moderationState)) return null;

    const category = await this.categories.findBySlug(listing.categorySlug);
    /* c8 ignore next -- unreachable: a listing cannot exist without its category. */
    if (category === null) return null;

    return {
      id: listing.id,
      ownerId: listing.ownerId,
      title: listing.title,
      // The pinned version's name, which is what the public listing page shows —
      // so a booking's copy says what the renter was looking at.
      categoryName: listing.categoryName,
      rates: listing.rates,
      currentFeePolicy: category.feePolicy,
      /*
       * **The category's current band, not one frozen when the listing was
       * created** — `hydrate`'s argument (ADR 0042). The *quote* is what fixes
       * the resulting amount, so a double that froze it here would let a test
       * prove the opposite of production.
       */
      currentDamageSecurity: category.damageSecurity,
      replacementValue: listing.replacementValue,
      currentMaximumRentalDays: category.maximumRentalDays,
      currentRequestExpiryHours: category.requestExpiryHours,
      currentCategoryVersionId: `${category.id}:v${String(category.versionNumber)}`,
    };
  }

  async findPublished(id: string): Promise<PublicListingRecord | null> {
    const listing = this.listings.find((candidate) => candidate.id === id);
    if (listing === undefined) return null;
    if (!isPubliclyVisible(listing.status, listing.moderationState)) return null;

    const location = listing.collectionLocation;
    /* c8 ignore next -- publication refuses a listing with no address. */
    if (location === null) return null;

    const hydrated = await this.hydrate(listing);

    const category = await this.categories.findBySlug(listing.categorySlug);
    /* c8 ignore next -- unreachable: a listing cannot exist without its category. */
    if (category === null) return null;

    const media = await this.publicMedia(hydrated.id);

    return {
      media,
      id: hydrated.id,
      ownerId: hydrated.ownerId,
      categorySlug: hydrated.categorySlug,
      categoryName: hydrated.categoryName,
      categoryAttributes: hydrated.categoryAttributes,
      currentFeePolicy: hydrated.currentFeePolicy,
      /*
       * **The category's *current* band, not one captured when the listing was
       * created** — `hydrate`'s argument applied to the second shop-window fact
       * (ADR 0042). A double that froze the band would let a test prove the
       * opposite of production: that reconfiguring a category's damage security
       * leaves an existing listing's disclosed hold alone. It does not.
       */
      currentDamageSecurity: category.damageSecurity,
      replacementValue: hydrated.replacementValue,
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

      // `[0]` because a card gets one, matching the adapter's `take: 1` — and
      // `?? null` because most listings have no photograph, which is ordinary.
      const thumbnail = (await this.publicMedia(hydrated.id))[0]?.thumbnail ?? null;

      summaries.push({
        thumbnail,
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

  listIdsOwnedBy(ownerId: string): Promise<readonly string[]> {
    return Promise.resolve(
      this.listings.filter((listing) => listing.ownerId === ownerId).map((l) => l.id),
    );
  }

  eraseOwnedBy(ownerId: string, retain: ReadonlySet<string>): Promise<void> {
    /*
     * **Both halves modelled, because a fake that only deleted would certify
     * the bug this slice exists to prevent** (4.2). A service that passed an
     * empty `retain` — or forgot to ask Booking at all — would look correct
     * against a fake that ignores the argument, and would delete listings out
     * from under other people's rental history against the real one.
     */
    const survivors = this.listings.filter(
      (listing) => listing.ownerId !== ownerId || retain.has(listing.id),
    );
    // Spliced in place rather than reassigned, because the array is `readonly`
    // — the field, not its contents — and because a test holding a reference to
    // it should see the same emptying the store sees.
    this.listings.splice(0, this.listings.length, ...survivors);

    /*
     * **A retained listing loses its precise address and keeps the district and
     * town**, which is what the real adapter does by deleting the
     * `listing_locations` row — the street lines, the full postcode and the
     * fuzz offset all live there, while `outwardCode` and `town` are columns on
     * the listing itself (§8.4.1).
     *
     * **The first version of this dropped only the offset and left the address
     * standing**, which is the mismatch a fake exists to avoid: the service test
     * failed against it while the real store was correct. `collectionLocation`
     * is on the record here rather than in a second table, so modelling the
     * delete means nulling it.
     */
    for (const id of retain) this.offsets.delete(id);

    for (const [index, listing] of this.listings.entries()) {
      if (listing.ownerId === ownerId && retain.has(listing.id)) {
        this.listings[index] = { ...listing, collectionLocation: null };
      }
    }

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
  /**
   * The photographs service over the same listing store (slice 2.6b-i).
   *
   * On `ListingFakes` rather than built separately, because it is only usable
   * with *this* listing store — ownership is proved through it, so a media
   * service holding a different one would answer null to everything and every
   * test would pass without reaching the code under test.
   */
  readonly media: ListingMediaFakes;
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
   * Booking's fakes (slice 4.2), for the erasure tests.
   *
   * Exposed whole rather than as the narrowed port Catalogue declares, because
   * a test needs to *seed* a booking against a listing — `bookings.store.holds(id)`
   * — and the port deliberately offers no way to.
   */
  readonly bookings: ReturnType<typeof createBookingFakes>;
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

  /**
   * Every lookup, in order, as the list of ids it was asked about.
   *
   * Here so a test can assert **how many round trips a page of results costs**,
   * which is not visible in any response body. A search that resolved each
   * owner separately and one that resolved them together return byte-identical
   * JSON, so without this the N+1 the audit found could be reintroduced by a
   * refactor with every assertion still green.
   */
  readonly lookups: (readonly string[])[] = [];

  /**
   * Forget what has been asked so far.
   *
   * Test setup goes through the real publication path, which asks this question
   * too — so a test about what a *search* costs has to start counting after its
   * fixtures exist, or it measures the fixtures.
   */
  forgetLookups(): this {
    this.lookups.length = 0;
    return this;
  }

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

  findOwnerStatuses(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, OwnerStatus>> {
    this.lookups.push([...userIds]);

    const statuses = new Map<string, OwnerStatus>();
    for (const userId of userIds) {
      const status = this.declared.has(userId)
        ? (this.declared.get(userId) ?? null)
        : this.fallback;
      // Absent, never null. The port says an undeclared owner has no entry, and
      // a fake that answered with a null value would let a service that reads
      // `.has()` rather than the value pass here and refuse nobody in
      // production.
      if (status !== null) statuses.set(userId, status);
    }

    return Promise.resolve(statuses);
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
  // Booking's own fakes rather than a stub, so an erasure test goes through the
  // real "which listings are referenced" answer (slice 4.2). A stub returning an
  // empty set would let a service that never asked pass — which is precisely the
  // defect that would delete listings out from under other people's history.
  const bookings = createBookingFakes();
  const media = createListingMediaFakes(listings);
  /*
   * **Wired both ways, and this line is why a media assertion can fail.**
   * Without it the listing store's two public projections return no
   * photographs whatever the media store holds, so every test about a
   * photograph reaching a public read would pass with no photograph anywhere.
   */
  listings.useMedia(media.store);

  return {
    categories,
    listings,
    media,
    geocoder,
    logger,
    publication,
    audit,
    ownerStatuses,
    proximity,
    bookings,
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
      bookings.references,
      // The real media service, not a stub. An erasure test must go through the
      // code that actually deletes the objects — a stub that swallowed the call
      // would let a service that never erased a photograph pass, which is the
      // precise defect this port exists to prevent.
      media.service,
      // The same object store the media service writes through, so a signed URL
      // in a public projection refers to bytes a test actually uploaded.
      new ListingImageSigner(media.objects),
    ),
  };
}

/**
 * An object store in a Map.
 *
 * BRD §5 requires a fake beside every provider adapter, and this one carries
 * the three behaviours a test would otherwise get wrong by assuming S3 is a
 * filesystem:
 *
 *   - **`delete` on an absent key succeeds.** It is not an error in S3 and it
 *     must not be one here, or a test would pin behaviour the real store does
 *     not have and the retry path would look broken.
 *   - **`put` replaces.** The same key twice is one object, which is what makes
 *     a caller's retry safe.
 *   - **`signedUrl` does no lookup.** It returns a URL for a key that was never
 *     written, exactly as signing arithmetic does, so a test cannot come to
 *     rely on the store telling it something exists.
 *
 * It also holds what was stored, because the assertions worth making are about
 * the *bytes* — that what reached the store carries no EXIF, and that a deleted
 * listing left nothing behind.
 */
export class InMemoryObjectStore extends MemoryObjectStore {
  private failure: ObjectStoreUnavailableError | null = null;

  /** Every key written, in order, so a test can assert what was stored and when. */
  readonly written: string[] = [];
  /**
   * How many URLs have been signed (slice 2.6b-ii).
   *
   * **A count rather than a list of keys**, because what it exists to prove is
   * a *negative*: that a read which refuses a listing signed nothing for it. A
   * signed URL is a fifteen-minute grant of access to a private object, and
   * `signedUrl` does no network call — so minting one for a listing nobody may
   * see fails nothing and logs nothing, and the only observable trace is that
   * the store was asked.
   */
  signings = 0;
  /** Every key deleted, including ones that were never there. */
  readonly deleted: string[] = [];

  /**
   * Make the **next** operation fail, once.
   *
   * Once rather than permanently, so a test can assert the recovery as well as
   * the failure — the same shape `FakeGeocoder.willFail` uses.
   */
  willFail(message = 'The object store could not be reached'): this {
    this.failure = new ObjectStoreUnavailableError(message);
    return this;
  }

  /**
   * **Rejects rather than throwing synchronously**, because `R2ObjectStore`'s
   * methods are `async` and therefore can only ever reject.
   *
   * Found by a test: a caller using `.catch()` — which handles a rejection and
   * not a synchronous throw — passed against the real adapter and failed against
   * this double. A double that fails in a way production cannot is worse than no
   * double, because it sends you to fix code that was already correct.
   */
  private takeFailure(): Promise<void> | null {
    const failure = this.failure;
    if (failure === null) return null;
    this.failure = null;
    return Promise.reject(failure);
  }

  override put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const failed = this.takeFailure();
    if (failed !== null) return failed;

    this.written.push(key);
    return super.put(key, bytes, contentType);
  }

  /**
   * Signs exactly as the parent does, and counts (slice 2.6b-ii).
   *
   * **It does not consume `willFail`**, matching the real adapter: presigning is
   * local arithmetic over a key and a credential, so it cannot discover that the
   * bucket is unreachable. A double that failed here would send somebody to
   * write error handling for a case production does not have.
   */
  override signedUrl(key: string, ttlSeconds: number): Promise<string> {
    this.signings += 1;
    return super.signedUrl(key, ttlSeconds);
  }

  override delete(key: string): Promise<void> {
    const failed = this.takeFailure();
    if (failed !== null) return failed;

    this.deleted.push(key);
    return super.delete(key);
  }

  /** What is stored at a key, or null. For asserting on bytes. */
  read(key: string): { bytes: Buffer; contentType: string } | null {
    return this.objects.get(key) ?? null;
  }

  get size(): number {
    return this.objects.size;
  }
}

/**
 * `listing_media` in a Map (slice 2.6b-i).
 *
 * **Mirrors the two behaviours the real table has that a naive double would
 * not**, which is this file's standing rule:
 *
 *   - **Reads come back in `(position, createdAt, id)` order**, the total order
 *     that makes the absent unique constraint on `(listingId, position)` safe.
 *     A double returning insertion order would let a test pass while the real
 *     store returned something else the moment two rows shared a position.
 *   - **`append` picks the position** by reading the current maximum, so a test
 *     never supplies one — matching the port, where a caller that chose its own
 *     position would be racing.
 *
 * It deliberately does **not** mirror the foreign key: deleting a listing does
 * not cascade here. Nothing in the fake world deletes a listing without going
 * through the service, and a hand-rolled cascade would be a second, divergent
 * implementation of a rule Postgres already owns — the sort a test comes to
 * depend on and production does not have.
 */
export class InMemoryListingMediaStore implements ListingMediaStore {
  private readonly rows = new Map<string, ListingMediaRecord>();
  private sequence = 0;

  /**
   * Move one photograph's moderation state (slice 2.6b-ii).
   *
   * **A test affordance with no production counterpart, deliberately.** No
   * route moderates a photograph until Phase 9 — §6.2 asked for the column and
   * 2.6b-i added it so it would not have to be retrofitted onto existing rows —
   * so the public read's `APPROVED` filter has nothing that can exercise it
   * through the API. Without this the filter would be untested until the day it
   * mattered, which is the day a rejected photograph is already public.
   *
   * It is on the double rather than the port for exactly that reason: adding
   * `setModerationState` to `ListingMediaStore` would put a write on the
   * interface that production has no caller for, and Phase 9's real one will
   * want a moderator, a reason and an audit entry rather than this.
   */
  setModerationState(mediaId: string, state: string): void {
    const row = this.rows.get(mediaId);
    if (row === undefined) throw new Error(`No such photograph: ${mediaId}`);
    this.rows.set(mediaId, { ...row, moderationState: state });
  }

  private ordered(listingId: string): ListingMediaRecord[] {
    return [...this.rows.values()]
      .filter((row) => row.listingId === listingId)
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  }

  listFor(listingId: string): Promise<readonly ListingMediaRecord[]> {
    return Promise.resolve(this.ordered(listingId));
  }

  listForListings(
    listingIds: readonly string[],
  ): Promise<readonly ListingMediaRecord[]> {
    const wanted = new Set(listingIds);
    return Promise.resolve(
      [...this.rows.values()].filter((row) => wanted.has(row.listingId)),
    );
  }

  append(media: NewListingMedia): Promise<ListingMediaRecord> {
    const existing = this.ordered(media.listingId);
    const last = existing[existing.length - 1];

    this.sequence += 1;
    const record: ListingMediaRecord = {
      // A real UUID, because the column is one and the contract validates it as
      // one. A readable `media-1` here would have every projection fail its own
      // schema — which is how this was found.
      id: randomUUID(),
      listingId: media.listingId,
      position: last === undefined ? 0 : last.position + 1,
      displayKey: media.displayKey,
      thumbnailKey: media.thumbnailKey,
      contentType: media.contentType,
      byteSize: media.byteSize,
      width: media.width,
      height: media.height,
      thumbnailWidth: media.thumbnailWidth,
      thumbnailHeight: media.thumbnailHeight,
      sha256: media.sha256,
      moderationState: DEFAULT_MODERATION_STATE,
      /*
       * Distinct and increasing, so the `(position, createdAt, id)` tiebreak is
       * exercisable rather than every row sharing one instant.
       *
       * `Time.nowUtc()` plus the sequence rather than a literal date: the
       * project bans a bare `Date` so that timezone handling stays explicit, and
       * a fake is not an exception — a double that reaches for `new Date` is one
       * that will disagree with production about what "now" means.
       */
      createdAt: Time.fromEpochMs(Time.nowUtc().getTime() + this.sequence),
    };

    this.rows.set(record.id, record);
    return Promise.resolve(record);
  }

  remove(listingId: string, mediaId: string): Promise<ListingMediaRecord | null> {
    const row = this.rows.get(mediaId);
    // Scoped by both, exactly as the adapter is: matching on the media id alone
    // would let a test pass that the real store would refuse.
    if (row === undefined || row.listingId !== listingId) {
      return Promise.resolve(null);
    }

    this.rows.delete(mediaId);
    return Promise.resolve(row);
  }

  reorder(listingId: string, mediaIds: readonly string[]): Promise<void> {
    mediaIds.forEach((id, position) => {
      const row = this.rows.get(id);
      if (row === undefined || row.listingId !== listingId) return;
      this.rows.set(id, { ...row, position });
    });

    return Promise.resolve();
  }

  deleteFor(listingIds: readonly string[]): Promise<void> {
    const wanted = new Set(listingIds);
    for (const [id, row] of this.rows) {
      if (wanted.has(row.listingId)) this.rows.delete(id);
    }

    return Promise.resolve();
  }

  /** Every row, for asserting that an erasure left nothing behind. */
  get all(): readonly ListingMediaRecord[] {
    return [...this.rows.values()];
  }
}

export interface ListingMediaFakes {
  readonly store: InMemoryListingMediaStore;
  readonly objects: InMemoryObjectStore;
  readonly logger: RecordingLogger;
  readonly service: ListingMediaService;
}

/**
 * A media service over in-memory everything.
 *
 * Takes the listing store rather than creating one, because ownership is proved
 * through it: a media service with its own empty listing store would answer
 * `null` to every call, and every test would pass by never reaching the code
 * under test.
 */
export function createListingMediaFakes(
  listings: InMemoryListingStore,
): ListingMediaFakes {
  const store = new InMemoryListingMediaStore();
  const objects = new InMemoryObjectStore();
  const logger = createRecordingLogger();

  return {
    store,
    objects,
    logger,
    service: new ListingMediaService(listings, store, objects, logger.logger),
  };
}

/**
 * The two Catalogue services `AppModule.register` requires, ready to spread.
 *
 * **The counterpart to `bookingModuleFakes`, and it exists for the same
 * reason.** Slice 2.6b-i made `listingMedia` a required module option — on the
 * argument that an optional one is what ten boot sites forget — and that turned
 * every `AppModule.register` in the suite into a compile error. A helper that
 * spreads both keeps the fix to one line per site, and means the next required
 * Catalogue service is one edit here rather than twenty-three.
 *
 * ```ts
 * AppModule.register({ ...listingModuleFakes(categories), audit: audit.service })
 * ```
 */
export function listingModuleFakes(
  categories?: InMemoryCategoryStore,
  audit?: AuditFakes,
): { listings: ListingsService; listingMedia: ListingMediaService } {
  const fakes = createListingFakes(categories, audit);
  return { listings: fakes.service, listingMedia: fakes.media.service };
}
