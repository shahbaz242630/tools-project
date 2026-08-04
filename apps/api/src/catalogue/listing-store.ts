import type { ListingStatus } from '@platform/contracts';
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
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
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

export interface ListingStore {
  /**
   * Create a draft, pinning whichever category version is current right now.
   *
   * Throws `UnknownCategoryError` if the slug names no category.
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
 * surface and returns the risk level, the reportable-activity flag and the whole
 * attribute schema; this returns what an owner needs to pick a category and
 * nothing else. Two ports rather than one with a projection argument, for the
 * reason `profiles.ts` gives about its two response shapes: a projection
 * argument is one a caller can forget.
 */
export interface CategoryOptionRecord {
  readonly slug: string;
  readonly name: string;
}

export interface CategoryOptionSource {
  /** Every category, oldest first, as options. */
  listOptions(): Promise<readonly CategoryOptionRecord[]>;
}
