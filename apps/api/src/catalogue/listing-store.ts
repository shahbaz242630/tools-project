import type {
  CategoryAttribute,
  CategoryTransportOption,
  ListingAttributeValues,
  ListingCollectionLocation,
  ListingStatus,
  TransportRequirement,
} from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import type { LocatedListingPoint } from './listing-locator.js';

/**
 * Listings, as the rest of the application sees them.
 *
 * **Every read here is scoped by owner, and that is the design.** There is no
 * `findById(id)` — only `findOwnedBy(id, ownerId)` — because a port offering an
 * unscoped read is a port some later route calls without remembering to check
 * whose listing it got back. The public projection slice 2.10 needs will be its
 * own method with its own name, so that the two can never be confused at a call
 * site.
 *
 * The Catalogue module reaches these rows only through this interface, the same
 * boundary rule that keeps Profiles out of `users` (BRD §5.1).
 */

/** A listing as its owner sees it, with the category it was written against. */
export interface ListingRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly categoryVersionNumber: number;
  /**
   * The attribute schema **as pinned**, read from the version this listing
   * points at rather than from the category as it stands now.
   *
   * A value cannot be read without it: `25` means nothing until something says
   * it is a weight in kilograms at one decimal place, and `cordless` means
   * nothing without the label it was chosen by.
   */
  readonly categoryAttributes: readonly CategoryAttribute[];
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  /** Answers keyed by attribute key. An unanswered attribute is absent. */
  readonly attributes: ListingAttributeValues;
  /** What it takes to collect it, or null on a draft that has not said (§8.3). */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * Where it is collected from, **decrypted**, or null on a draft that has not
   * said.
   *
   * This record is the owner's view, so it carries the precise half. The
   * decryption happens in the adapter, which is the only thing holding the key —
   * the same division `PrismaProfileStore` makes, and the reason neither service
   * ever sees an envelope.
   *
   * 2.10's public projection is a different method returning a different type
   * (`CoarseLocation`), so a route cannot reach the precise half by asking the
   * wrong question.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  /**
   * Whether the collection postcode has been resolved to a point (slice 2.5b).
   *
   * **A boolean, not the coordinates.** Nothing above the store needs to know
   * where the listing is: the owner sees their own address, and the published
   * point is Phase 3's business. What an owner does need to know is that their
   * listing is not yet locatable, because §8.3's draft is permissive and slice
   * 2.8 will refuse to publish without it.
   *
   * Exposing the pair here instead would put true coordinates on the record that
   * every controller maps to a response, which is exactly the shape §8.4.1 says
   * must never reach a public projection.
   */
  readonly isLocated: boolean;
  readonly status: ListingStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What an owner supplies, plus what the server decides.
 *
 * `categoryVersionId` and `categoryId` are **not** here: the store resolves them
 * from the slug itself, at the moment of writing. Passing them in would mean a
 * caller could pin a version it read some time ago, which is exactly the stale
 * pin the version exists to prevent — and it would put the burden of keeping the
 * pair consistent on every caller rather than on the one place that can.
 */
export interface ListingDraft {
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  /**
   * Already validated against the schema on version `categoryVersionNumber`.
   *
   * The store does not know the attribute vocabulary and must not learn it —
   * that is domain logic and lives in the service (BRD §5.1). What the store
   * guarantees is narrower and is the thing the service cannot do for itself:
   * that the version it ends up pinning is the version these were checked
   * against.
   */
  readonly attributes: ListingAttributeValues;
  /**
   * Already checked against the options on version `categoryVersionNumber`.
   *
   * Same division of labour as the attributes: the service decides whether the
   * category offers this requirement, because that is domain meaning, and the
   * store only guarantees the version it pins is the one that was checked.
   */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * Where the item is collected from, in plaintext.
   *
   * **The port speaks plaintext and the adapter encrypts**, exactly as
   * `ProfileStore` does. It is what stops a caller forgetting to encrypt on a
   * path somebody adds later: there is no way to reach the database with a
   * street line except through the one method that puts it in an envelope.
   *
   * The outward code is *not* here. It is derived from the postcode on write, in
   * the adapter, because that is the only place the two can diverge — the same
   * reasoning `addresses.outwardCode` records.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  /**
   * Where that postcode is, with its fuzz offset already drawn (slice 2.5b).
   *
   * **Null is ordinary**, and means either that the geocoder does not recognise
   * the postcode or that it could not be reached. §8.3 makes a draft permissive
   * and neither may stop a save; slice 2.8 is where publication refuses a
   * listing nothing can find.
   *
   * Always null when `collectionLocation` is null — there is nothing to
   * geocode — and the store does not check that, because the service is what
   * produces both from one address. What the *database* checks is the narrower
   * thing only it can see: that all six coordinate columns are set together.
   *
   * Like the attribute values, this arrives already decided. The store does not
   * know what a fuzz offset is and must not learn: that is domain logic living
   * in Search & Location (BRD §5.1).
   */
  readonly locatedPoint: LocatedListingPoint | null;
  /**
   * The version the values above were validated against.
   *
   * **This is a guard, not a choice.** The store still pins whatever is current
   * when it writes; if that is no longer this number, it refuses rather than
   * writing answers checked against a schema that has been replaced. Closing
   * that window inside the write is the only place it can be closed — a check
   * in the service would leave the gap between its read and the store's.
   */
  readonly categoryVersionNumber: number;
}

/**
 * Raised when the category a draft names does not exist.
 *
 * Its own error rather than a null return, because the caller has to tell it
 * apart from "you have no listing with that id": one is a 404 about a category
 * the owner chose from a list that has since changed, and the other is a 404
 * about a listing. Same status code, completely different message.
 */
export class UnknownCategoryError extends Error {
  constructor(readonly slug: string) {
    super(`No category has the slug "${slug}"`);
    this.name = 'UnknownCategoryError';
  }
}

/**
 * Raised when the category was reconfigured while the form was open.
 *
 * A 409 rather than a 400: nothing the owner typed is wrong, and there is no
 * field for them to correct. The configuration moved underneath them, which is
 * a conflict about state rather than a fault in the request.
 *
 * **It is refused rather than accommodated, and that is the point.** Validating
 * against the new schema instead would silently drop an answer to an attribute
 * that had just been renamed or removed — throwing away something somebody typed
 * without telling them. Pinning the old version instead would be worse: the
 * listing would claim configuration nobody could see any more.
 */
export class CategoryChangedError extends Error {
  constructor(
    readonly slug: string,
    readonly expectedVersionNumber: number,
    readonly actualVersionNumber: number,
  ) {
    super(
      `Category "${slug}" was configured as version ${String(
        expectedVersionNumber,
      )} when this form was opened and is now version ${String(actualVersionNumber)}`,
    );
    this.name = 'CategoryChangedError';
  }
}

export interface ListingStore {
  /**
   * Create a draft, pinning whichever category version is current right now.
   *
   * Throws `UnknownCategoryError` if the slug names no category, and
   * `CategoryChangedError` if the version it would pin is not the one the
   * draft's values were validated against.
   */
  createDraft(draft: ListingDraft): Promise<ListingRecord>;

  /**
   * One listing, but only if this owner owns it.
   *
   * Resolves to null both when the listing does not exist and when it belongs to
   * somebody else, so that a caller cannot accidentally distinguish the two —
   * telling a stranger "that exists but is not yours" confirms it exists.
   */
  findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null>;

  /**
   * Every listing this owner has, newest first.
   *
   * Exists for the data export, which is what made Catalogue a personal-data
   * module in the first place. Slice 2.9's owner dashboard wants the same query
   * and should reuse it rather than adding a second one that can drift in
   * ordering.
   */
  listOwnedBy(ownerId: string): Promise<readonly ListingRecord[]>;

  /**
   * Erase everything precise about where this owner's listings are.
   *
   * **It erases locations, not listings, and the name says so.** A listing must
   * survive its owner's account deletion — from Phase 4 a booking references it,
   * and a rental history that loses one side is not a history. What must not
   * survive is the front door: the full postcode and the street lines go, and
   * the outward code and town stay on the listing, so it collapses to the
   * coarseness it was always published at.
   *
   * Whether a deleted owner's listing should still be *visible* is a different
   * question, and it is slice 2.8's — that is archival, and it has to be settled
   * before any real user data exists.
   *
   * **Idempotent**, as `PersonalDataEraser` requires: erasing what is already
   * gone is a success, because a retry after a partial failure has to be able to
   * finish the job.
   */
  eraseLocationsFor(ownerId: string): Promise<void>;
}

/**
 * The categories somebody choosing one may see.
 *
 * A separate port from `CategoryStore`, deliberately. That one serves the admin
 * surface and returns the risk level and the reportable-activity flag; this
 * returns what an owner needs to pick a category and fill in its fields, and
 * nothing else. Two ports rather than one with a projection argument, for the
 * reason `profiles.ts` gives about its two response shapes: a projection
 * argument is one a caller can forget.
 *
 * The attribute schema is on both, and that is not duplication — it is the one
 * piece of category configuration an owner legitimately needs, because it is the
 * form they are about to fill in.
 */
export interface CategoryOptionRecord {
  readonly slug: string;
  readonly name: string;
  /** The current schema, in render order. Empty is legitimate. */
  readonly attributes: readonly CategoryAttribute[];
  /**
   * Which transport requirements this category offers, and their weight
   * thresholds (§8.3, ADR 0031). Empty means the listing form asks nothing about
   * how the item is collected, which is what a category configured before slice
   * 2.4c-i has.
   */
  readonly transportOptions: readonly CategoryTransportOption[];
  /** Which version the schema above came from. */
  readonly versionNumber: number;
}

export interface CategoryOptionSource {
  /** Every category, oldest first, as options. */
  listOptions(): Promise<readonly CategoryOptionRecord[]>;

  /**
   * One category's current configuration, or null if the slug names none.
   *
   * Separate from `listOptions` rather than filtering it, because the service
   * needs exactly one row on the write path and reading every category to find
   * it would be a query that grows with the catalogue on the hottest path a
   * listing has.
   */
  findOption(slug: string): Promise<CategoryOptionRecord | null>;
}
