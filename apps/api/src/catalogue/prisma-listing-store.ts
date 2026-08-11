import type { PrismaClient } from '@platform/database';
import type {
  CategoryAttribute,
  CategoryTransportOption,
  ListingAttributeValues,
  ListingCollectionLocation,
  ListingStatus,
  ModerationState,
  TransportRequirement,
} from '@platform/contracts';
import {
  LISTING_STATUSES,
  MODERATION_STATES,
  TRANSPORT_REQUIREMENTS,
  parseCategoryAttributes,
  parseCategoryTransportOptions,
} from '@platform/contracts';
import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import { Money, Postcode } from '@platform/core';
import type { FieldEncryptor } from '../encryption/field-encryption.js';
import { CategoryChangedError, UnknownCategoryError } from './listing-store.js';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  ListingEdit,
  ListingDraft,
  ListingRecord,
  ListingStore,
  ModerationDecision,
} from './listing-store.js';

/**
 * Postgres-backed listings.
 *
 * The one thing worth reading closely is `createDraft`: it resolves the category
 * and pins its current version **inside the same statement that writes the
 * row**, so no caller ever holds a version id long enough for it to go stale.
 *
 * **Encryption lives here and nowhere else**, the same rule
 * `PrismaProfileStore` follows. The port above speaks plaintext, so no caller
 * can forget to encrypt on a path somebody adds later: the only way a street
 * line reaches the database is through `createDraft`, and the only way one comes
 * back is through `toRecord`.
 */
export class PrismaListingStore implements ListingStore, CategoryOptionSource {
  constructor(
    private readonly prisma: PrismaClient,
    /**
     * Catalogue holds personal data from slice 2.5a, which is why this argument
     * exists at all. Before it, `main.ts` noted that Catalogue "holds no
     * personal data and answers no question about a person, which is why it
     * needs neither the encryptor nor a lookup into identity" — the first half
     * of that sentence stopped being true the moment a listing carried an
     * address.
     */
    private readonly encryptor: FieldEncryptor,
  ) {}

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

    const location = draft.collectionLocation;

    // The listing and its location are written as one unit, for the reason
    // `PrismaProfileStore.save` gives about a profile and its address: they are
    // two tables holding one answer to one form, and a failure between the two
    // writes leaves a listing claiming a district it has no address for.
    //
    // Two statements rather than a nested create, because the envelope binds the
    // **listing id** as additional authenticated data and that id does not exist
    // until the first insert returns. The alternative — minting the uuid here so
    // one nested write could do both — would move identity generation out of the
    // database to buy a round trip inside a transaction that is already open.
    const listing = await this.prisma.$transaction(async (tx) => {
      const created = await tx.listing.create({
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
          ...rateColumns(draft.rates),
          attributes: draft.attributes,
          transportRequirement: draft.transportRequirement,
          requiresTwoPersonLift: draft.requiresTwoPersonLift,
          // The publishable half, derived on write from the same postcode that
          // is about to be stored. This is the one place the two can diverge, so
          // it is the one place that derives one from the other — the rule
          // `addresses.outwardCode` established.
          outwardCode:
            location === null ? null : Postcode.outwardCode(location.postcode),
          town: location?.town ?? null,
          status: DRAFT,
        },
        include: LISTING_CATEGORY,
      });

      if (location === null) return created;

      const stored = await tx.listingLocation.create({
        data: {
          listingId: created.id,
          postcode: location.postcode,
          encryptedDetail: this.encrypt(created.id, {
            line1: location.line1,
            line2: location.line2,
          }),
          // All six together or none — the service produces them as one object
          // and `location_is_geocoded_or_not` refuses any half state. Spread
          // rather than written field by field so that a column added to
          // `LocatedListingPoint` cannot be silently dropped here.
          ...(draft.locatedPoint ?? {}),
          // `fuzzedPoint` is absent on purpose: the trigger derives it from the
          // fuzzed pair. Writing it from here would be a second source of truth
          // for the one column BRD §4.2 says Prisma cannot express.
        },
      });

      // Re-attached rather than re-read. The include above ran before this row
      // existed, and issuing a second select for a value we are holding would be
      // a query whose only purpose is to fetch what we just wrote.
      return { ...created, location: stored };
    });

    return this.toRecord(listing);
  }

  async findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null> {
    // The owner is part of the *query*, not a check applied to the result. A
    // read that fetches first and compares afterwards is one somebody later
    // refactors into a read that forgets to compare.
    const listing = await this.prisma.listing.findFirst({
      where: { id, ownerId },
      include: LISTING_CATEGORY,
    });

    return listing === null ? null : this.toRecord(listing);
  }

  async update(
    id: string,
    ownerId: string,
    edit: ListingEdit,
  ): Promise<ListingRecord | null> {
    /*
     * **Ownership first, and read rather than written**, because the version
     * this edit will pin has to be resolved from *this listing's* category —
     * which is a fact about the row, not something the caller may supply. An
     * edit carries no category at all (see `ListingEdit`), so there is nothing
     * for a caller to point at another category with.
     */
    const existing = await this.prisma.listing.findFirst({
      where: { id, ownerId },
      // Through `categoryVersion`, because a listing has no direct relation to
      // its category — the composite foreign key points at the *version*, and
      // `categoryId` is the column that travels with it. The slug is wanted only
      // for the refusal message.
      select: {
        categoryId: true,
        categoryVersion: { select: { category: { select: { slug: true } } } },
      },
    });
    if (existing === null) return null;

    const current = await this.prisma.categoryVersion.findFirst({
      where: { categoryId: existing.categoryId },
      orderBy: { versionNumber: 'desc' },
    });
    /* c8 ignore next 2 -- unreachable: this listing holds a composite foreign key
       to a version of this category, so at least one exists. */
    if (current === null) return null;

    // The same guard `createDraft` makes, and it is **not** redundant with the
    // service's: between that read and this one a reconfiguration could land,
    // and pinning then would store answers checked against a schema this row
    // would no longer point at (ADR 0029, and ADR 0042 is what made an *edit*
    // able to race at all — before it, an edit revalidated against a row a
    // trigger refuses to update).
    if (current.versionNumber !== edit.categoryVersionNumber) {
      throw new CategoryChangedError(
        existing.categoryVersion.category.slug,
        edit.categoryVersionNumber,
        current.versionNumber,
      );
    }

    /*
     * `updateMany` with the owner in the `where`, exactly as `publish` and
     * `pause` do — the ownership check happens inside the statement rather than
     * in a read-then-write two requests could interleave. The read above is for
     * the *category*, not for permission, and doing it twice is what keeps the
     * write itself safe.
     *
     * **`categoryVersionId` is written and `categoryId` is not.** The listing
     * stays in its category; only which configuration it answers to moves. The
     * composite foreign key means the pair still has to agree, and it does,
     * because `current` was resolved from this listing's own `categoryId`.
     *
     * **Nothing here touches `location`, `outwardCode`, `town`, `status` or
     * `moderationState`** — see `ListingStore.update` for why each is left
     * alone. `outwardCode` and `town` are omitted rather than rewritten from an
     * address this method was not given: they are derived from the postcode, and
     * the postcode is 2.9b-ii's.
     */
    const { count } = await this.prisma.listing.updateMany({
      where: { id, ownerId },
      data: {
        categoryVersionId: current.id,
        title: edit.title,
        description: edit.description,
        replacementValueAmount: edit.replacementValue.amount,
        replacementValueCurrency: edit.replacementValue.currency,
        ...rateColumns(edit.rates),
        attributes: edit.attributes,
        transportRequirement: edit.transportRequirement,
        requiresTwoPersonLift: edit.requiresTwoPersonLift,
      },
    });

    /* c8 ignore next -- the row was read a statement ago and only a concurrent
       erasure could remove it. */
    if (count === 0) return null;

    // Re-read rather than assembled from what was written: the row carries a
    // fresh `updatedAt`, the newly pinned version's name and schema, and the
    // category's current fee policy — inventing any of them here would be a
    // second source of truth for what the caller is told.
    return this.findOwnedBy(id, ownerId);
  }

  async publish(id: string, ownerId: string): Promise<ListingRecord | null> {
    /*
     * The owner is in the `where`, not a comparison afterwards — `findOwnedBy`'s
     * rule, and it matters more on a write: a read that forgets to compare
     * discloses a listing, a write that forgets to compare *changes somebody
     * else's*.
     *
     * `updateMany` rather than `update`, because `update` needs a unique filter
     * and `ownerId` is not part of one. It reports how many rows it touched,
     * which is exactly the "was it theirs" answer needed here — and it does the
     * check inside the statement rather than in a read-then-write that two
     * concurrent requests could interleave.
     *
     * **Idempotent by construction**: the filter does not exclude already-published
     * rows, so publishing twice writes `PUBLISHED` over `PUBLISHED` and reports
     * one row either way. A filter of `status: 'DRAFT'` would have made the
     * second call indistinguishable from somebody else's listing.
     */
    const { count } = await this.prisma.listing.updateMany({
      where: { id, ownerId },
      data: { status: 'PUBLISHED' },
    });

    if (count === 0) return null;

    // Re-read rather than construct the record from what was written: the row
    // carries a fresh `updatedAt` and the joined category version, and inventing
    // either here would be a second source of truth for what the caller is told.
    return this.findOwnedBy(id, ownerId);
  }

  async pause(id: string, ownerId: string): Promise<ListingRecord | null> {
    /*
     * `publish`'s shape, deliberately identical — the owner inside the `where`
     * so a forgotten comparison cannot change a stranger's listing, `updateMany`
     * so the ownership check happens inside the statement rather than in a
     * read-then-write two requests could interleave, and no `status` in the
     * filter so that pausing twice is a success rather than a 404.
     *
     * Whether the transition is *legal* from the listing's current state is the
     * service's question, not this one's. It reads the row first and refuses a
     * draft; by the time this runs, the answer is yes.
     */
    const { count } = await this.prisma.listing.updateMany({
      where: { id, ownerId },
      data: { status: 'PAUSED' },
    });

    if (count === 0) return null;

    return this.findOwnedBy(id, ownerId);
  }

  /**
   * Read a listing without an owner filter (slice 2.8c-i).
   *
   * **Every other read here scopes by owner and this one deliberately cannot.**
   * A moderator acts on listings that are not theirs, so the `where` that
   * protects the rest of this adapter has nothing to contribute, and the role
   * check at the guard is the whole control. The name is the warning.
   */
  async findForModeration(id: string): Promise<ListingRecord | null> {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      include: LISTING_CATEGORY,
    });

    return listing === null ? null : this.toRecord(listing);
  }

  async moderate(input: ModerationDecision): Promise<ListingRecord | null> {
    /*
     * `update` rather than `updateMany`, and the difference from `publish` and
     * `pause` is instructive. Those use `updateMany` because `ownerId` is not
     * part of a unique filter and the ownership check has to happen inside the
     * statement. Here there is no ownership to check, `id` *is* unique, and
     * `update` says so — it throws on a missing row rather than reporting zero.
     *
     * The read below is what turns that into a null, so the route can answer
     * 404 without the caller learning whether a listing exists. A moderator
     * knowing that is harmless; the uniformity is not, because a route that
     * behaves differently for a real id is a probe.
     */
    const existing = await this.prisma.listing.findUnique({
      where: { id: input.listingId },
      select: { id: true },
    });
    if (existing === null) return null;

    await this.prisma.listing.update({
      where: { id: input.listingId },
      data: {
        moderationState: input.state,
        // Cleared when returning to `APPROVED`, so a reinstated listing does not
        // keep the sentence that took it down. The database would allow the old
        // reason to survive — the CHECK only constrains the hidden states — and
        // a stale one is worse than none: 2.8c-ii shows it to the owner.
        moderationReason: input.reason,
        moderatedById: input.moderatorId,
        moderatedAt: input.decidedAt,
      },
    });

    return this.findForModeration(input.listingId);
  }

  async listOwnedBy(ownerId: string, limit: number): Promise<readonly ListingRecord[]> {
    const listings = await this.prisma.listing.findMany({
      where: { ownerId },
      // Newest first, matching the index on `(ownerId, createdAt DESC)`. The
      // owner dashboard in 2.9 wants the same order, which is why this is one
      // method rather than two that can drift.
      orderBy: { createdAt: 'desc' },
      // The bound the caller asked for, and there is no default behind it (slice
      // H2). `take` is what turns this from a query that grows with an owner's
      // history into one whose cost is known before it runs.
      take: limit,
      include: LISTING_CATEGORY,
    });

    return listings.map((listing) => this.toRecord(listing));
  }

  /**
   * Delete every listing this owner has, and the locations that hang off them.
   *
   * **`deleteMany`, not `delete`**, because a missing row is not an error here:
   * somebody who never listed anything is still entitled to erasure, and a retry
   * after a partial failure has to be able to finish. That is what
   * `PersonalDataEraser` means by idempotent.
   *
   * **One statement, because `listing_locations` cascades.** Its foreign key is
   * `onDelete: Cascade`, so the precise address goes with the listing rather
   * than being deleted separately — and deleting it separately first would leave
   * a window in which the listing exists with its location already gone.
   *
   * **This deletes rows that until 2.8b were deliberately kept.** The reasoning
   * that kept them was Phase 4's: a booking will reference a listing, and a
   * rental history that loses one side is not a history. That is still true and
   * it is why the port's docblock says this method must change when the booking
   * foreign key arrives. Today nothing references a listing, so §10.1's
   * distinction between erasable personal data and retained transactional
   * records puts a listing firmly on the erasable side, and the product owner's
   * decision of 10 August 2026 is to erase it.
   *
   * Scoped by `ownerId` directly rather than by reading the ids first, so there
   * is no window in which a listing created between two statements survives.
   */
  async deleteAllOwnedBy(ownerId: string): Promise<void> {
    await this.prisma.listing.deleteMany({ where: { ownerId } });
  }

  async listOptions(limit: number): Promise<readonly CategoryOptionRecord[]> {
    const categories = await this.prisma.category.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
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

  /**
   * The listing id is bound into the ciphertext as additional authenticated
   * data.
   *
   * It means an encrypted address copied onto another listing's row fails to
   * decrypt rather than being served as that listing's — an attack available to
   * anyone with database write access but no key. The **listing** rather than
   * the owner, which is stricter than the profile store's binding: one owner may
   * have many listings at many addresses, and moving an address between two of
   * their own should fail too.
   */
  private encrypt(listingId: string, detail: EncryptedDetail): string {
    return this.encryptor.encrypt(JSON.stringify(detail), listingId);
  }

  private toRecord(listing: ListingRow): ListingRecord {
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
      // **The category's current version, not the pinned one** (ADR 0042) — the
      // one field on this record resolved from a different row than its
      // neighbours. `versions` is ordered descending and taken one, so `[0]` is
      // the latest; it cannot be empty, because a category with no version could
      // not have been pinned by this listing in the first place.
      currentFeePolicy: asFeePolicy(
        latestVersionOf(listing),
        `the current version of the category listed by ${listing.id}`,
      ),
      categoryTransportOptions: asTransportOptions(
        listing.categoryVersion.transportOptions,
        `the category version pinned by listing ${listing.id}`,
      ),
      title: listing.title,
      description: listing.description,
      replacementValue: asMoney(
        listing.replacementValueAmount,
        listing.replacementValueCurrency,
        listing.id,
      ),
      rates: asRateCard(listing),
      attributes: asValues(listing.attributes, listing.id),
      transportRequirement: asRequirement(listing.transportRequirement, listing.id),
      requiresTwoPersonLift: listing.requiresTwoPersonLift,
      collectionLocation: this.toLocation(listing),
      // A boolean, never the coordinates. §8.4.1 keeps true coordinates out of
      // every projection above this line, and the honest way to guarantee that
      // is for them not to be on the record at all.
      isLocated: listing.location?.latitude != null,
      status: asStatus(listing.status),
      moderationState: asModerationState(listing.moderationState),
      moderationReason: listing.moderationReason,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
    };
  }

  /**
   * The stored location, reassembled from the two tables it lives in.
   *
   * The town comes from the **listing** row rather than from inside the
   * envelope, because that is where the publishable copy lives and a second copy
   * in the ciphertext could disagree with it. A listing carrying a location row
   * always has that column — `location_is_complete` and the write transaction
   * both see to it — so the fallback below is unreachable. It is an empty string
   * rather than a throw because a town that has somehow gone missing should not
   * make somebody's own listing unopenable to them, and the street lines and
   * postcode beside it are still true.
   */
  private toLocation(listing: ListingRow): ListingCollectionLocation | null {
    if (listing.location === null) return null;

    const detail = JSON.parse(
      this.encryptor.decrypt(listing.location.encryptedDetail, listing.id),
    ) as EncryptedDetail;

    return {
      line1: detail.line1,
      line2: detail.line2,
      town: listing.town ?? '',
      postcode: listing.location.postcode,
    };
  }
}

/**
 * What goes inside the encrypted envelope.
 *
 * The identifying lines, and only those — the same split `PrismaProfileStore`
 * makes. `town` stays in a clear column because it is publishable, and
 * `postcode` stays in clear because slice 2.5b geocodes it: encrypting a value
 * the search index needs would mean decrypting every row to answer "what is near
 * me".
 */
interface EncryptedDetail {
  readonly line1: string;
  readonly line2: string | null;
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
  /**
   * The pinned version, **and the category's latest one beside it** (ADR 0042).
   *
   * Two versions of the same category arrive in one read because the record
   * needs both and they answer different questions. The pinned version says what
   * this listing's stored answers *mean*; the latest says what the platform
   * charges *today*. Resolving them in one query rather than two is what stops
   * the pair disagreeing — the same argument ADR 0034 makes for pricing having no
   * store of its own.
   *
   * `take: 1` on a descending `versionNumber` is the current configuration:
   * `category_versions` has a unique constraint on `(categoryId, versionNumber)`
   * and a trigger refusing `UPDATE`, so "highest" is unambiguous and a btree
   * scans backwards to find it.
   */
  categoryVersion: {
    include: {
      category: {
        include: {
          versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        },
      },
    },
  },
  /**
   * The precise half of the location, joined **only here**.
   *
   * This include belongs to the owner's own reads. Slice 2.10's public
   * projection and Phase 3's search must not reuse it — they read
   * `listings.outwardCode` and `listings.town`, which are on the row already and
   * have never held anything finer. That is the whole reason the two halves are
   * in different tables (BRD §8.4.1).
   */
  location: true,
} as const;

interface VersionRow {
  name: string;
  versionNumber: number;
  attributes: unknown;
  transportOptions: unknown;
  ownerCommissionBasisPoints: number;
  renterFeeBasisPoints: number;
  minimumBookingTotalAmount: number;
  minimumBookingTotalCurrency: string;
  minimumPlatformFeeAmount: number;
  minimumPlatformFeeCurrency: string;
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

/** The private half, as it comes out of `listing_locations`. */
interface LocationRow {
  postcode: string;
  encryptedDetail: string;
  /**
   * Null until the postcode has been geocoded — read only to answer *whether*
   * it has. The true coordinates go no further than this file (§8.4.1); Phase 7
   * will add a deliberate, audited method that discloses them once a booking
   * authorises collection.
   */
  latitude: number | null;
}

interface ListingRow {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  replacementValueAmount: number;
  replacementValueCurrency: string;
  dailyRateAmount: number | null;
  weekendRateAmount: number | null;
  weeklyRateAmount: number | null;
  rateCurrency: string;
  attributes: unknown;
  transportRequirement: string | null;
  requiresTwoPersonLift: boolean;
  /** The publishable half. Null together with `town` (`location_is_complete`). */
  town: string | null;
  status: string;
  /** Widened to `string` like `status`, and narrowed by `asModerationState`. */
  moderationState: string;
  moderationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  categoryVersion: VersionRow & {
    category: {
      slug: string;
      /**
       * The category's versions, ordered newest first and taken one — so this is
       * the *current* configuration, which the fee policy is read from (ADR 0042).
       *
       * An array rather than a single field because that is the shape a Prisma
       * `take: 1` include returns. `latestVersionOf` is the only thing that
       * unwraps it, so no call site has to remember that `[0]` means "latest".
       */
      versions: VersionRow[];
    };
  };
  /** Null for a draft that has not said where the item is. */
  location: LocationRow | null;
}

/**
 * The category's configuration as it stands now, for the fee policy (ADR 0042).
 *
 * **Falls back to the pinned version rather than throwing**, and the fallback is
 * unreachable: a listing has a composite foreign key to a version of this
 * category, so the category has at least one version by construction, and the
 * include asks for one. It is here because the alternative to a fallback is a
 * non-null assertion or a throw, and of the three this is the only one where a
 * database that somehow disagreed still serves the owner a price — computed from
 * the terms their listing was written under, which is the safest wrong answer
 * available.
 */
function latestVersionOf(listing: ListingRow): VersionRow {
  return listing.categoryVersion.category.versions[0] ?? listing.categoryVersion;
}

/**
 * The rate card, flattened into the four columns that hold it.
 *
 * One function rather than four properties at each write site, for
 * `feePolicyColumns`' reason: two paths writing a price differently is a
 * listing whose cost depends on which route last touched it.
 *
 * **The currency is written even when every rate is null.** The column is
 * `NOT NULL` with a default, and writing it explicitly means a listing priced
 * later inherits the currency it was created under rather than whatever the
 * default happens to be by then.
 */
function rateColumns(rates: ListingRateCard) {
  return {
    dailyRateAmount: rates.daily?.amount ?? null,
    weekendRateAmount: rates.weekend?.amount ?? null,
    weeklyRateAmount: rates.weekly?.amount ?? null,
    rateCurrency:
      rates.daily?.currency ??
      rates.weekend?.currency ??
      rates.weekly?.currency ??
      'GBP',
  };
}

/**
 * The four columns, on the way back out.
 *
 * Each amount goes through `asMoney`, which refuses a non-integer and an
 * unsupported currency — the same narrow guarantee the replacement value gets,
 * and for a stronger reason: this number is multiplied by a fee rate and shown
 * to a stranger as what they will pay.
 */
function asRateCard(listing: {
  id: string;
  dailyRateAmount: number | null;
  weekendRateAmount: number | null;
  weeklyRateAmount: number | null;
  rateCurrency: string;
}): ListingRateCard {
  const rate = (amount: number | null) =>
    amount === null ? null : asMoney(amount, listing.rateCurrency, listing.id);

  return {
    daily: rate(listing.dailyRateAmount),
    weekend: rate(listing.weekendRateAmount),
    weekly: rate(listing.weeklyRateAmount),
  };
}

/**
 * The pinned version's fee policy (ADR 0033).
 *
 * The currency gets the same treatment `asMoney` gives: a code this build
 * cannot do arithmetic in is not a display problem but an amount nothing can add
 * up, and `Money`'s operations would fail deep inside a fee calculation with a
 * message about currencies rather than about a listing.
 */
function asFeePolicy(version: VersionRow, what: string): CategoryFeePolicy {
  return {
    ownerCommissionBasisPoints: version.ownerCommissionBasisPoints,
    renterFeeBasisPoints: version.renterFeeBasisPoints,
    minimumBookingTotal: asMoney(
      version.minimumBookingTotalAmount,
      version.minimumBookingTotalCurrency,
      what,
    ),
    minimumPlatformFee: asMoney(
      version.minimumPlatformFeeAmount,
      version.minimumPlatformFeeCurrency,
      what,
    ),
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

/**
 * `asStatus` for the second authority, and it throws for the same reason.
 *
 * A row written by a newer build must not be read leniently. Defaulting an
 * unrecognised value to `APPROVED` would be the worst possible guess — it would
 * make a listing somebody had deliberately hidden visible again, silently, on a
 * rolled-back deploy.
 */
function asModerationState(value: string): ModerationState {
  if ((MODERATION_STATES as readonly string[]).includes(value)) {
    return value as ModerationState;
  }
  throw new Error(`Unknown listing moderation state in the database: ${value}`);
}
