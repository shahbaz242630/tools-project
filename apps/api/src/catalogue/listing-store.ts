import type {
  CategoryAttribute,
  ListingAttributeValues,
  ListingStatus,
} from '@platform/contracts';
import type { MoneyValue } from '@platform/core';

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
