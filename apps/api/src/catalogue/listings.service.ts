import { validateAttributeValues } from '@platform/contracts';
import type { AttributeValueIssue } from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  ListingRecord,
  ListingStore,
} from './listing-store.js';
import { CategoryChangedError, UnknownCategoryError } from './listing-store.js';

/**
 * What an owner submits: everything the wire carries, with the attribute values
 * still unchecked.
 *
 * Deliberately not `ListingDraft`. That is the store's shape and its
 * `attributes` are *validated* values — the difference between the two types is
 * exactly the work this service does, and collapsing them into one would make it
 * possible to reach the store with values nothing had looked at.
 */
export interface SubmittedListing {
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  readonly attributes: unknown;
  readonly categoryVersionNumber: number;
}

/**
 * Raised when the answers do not fit the category's schema.
 *
 * Carries the structured issues rather than a joined string so the controller
 * can hand a form the key of each offending field. A message assembled here
 * would be one the interface has to take apart again.
 */
export class AttributeValuesInvalidError extends Error {
  constructor(readonly issues: readonly AttributeValueIssue[]) {
    super(`The attribute values were rejected: ${String(issues.length)} problem(s)`);
    this.name = 'AttributeValuesInvalidError';
  }
}

/**
 * The Listings application service.
 *
 * **Nothing here is audited, and that is a decision rather than an omission.**
 * §8.13 requires an audit entry for administrative actions — an actor doing
 * something to somebody else, with a reason the subject can read. An owner
 * writing their own listing is neither: there is no second party, and demanding
 * a reason from somebody describing their own lawnmower would be the ritual that
 * makes the reasons which *do* matter look like paperwork.
 *
 * Slice 2.11 is where that changes. An administrator creating a listing on an
 * owner's behalf is an administrative action about another person's account, and
 * it must be audited **as that** rather than recorded as though the owner did
 * it. When that arrives it belongs in its own method here, not as a flag on
 * this one.
 */
export class ListingsService {
  constructor(
    private readonly store: ListingStore,
    private readonly categories: CategoryOptionSource,
  ) {}

  /**
   * Create a draft for this owner.
   *
   * Three things happen in order, and the order is the design.
   *
   * 1. **The category's current configuration is read.** Its schema is what the
   *    answers are checked against, because a listing may only ever be valid
   *    under the configuration it is about to pin.
   * 2. **The version is compared with the one the form was built from.** If the
   *    category has been reconfigured since the page was opened, the answers
   *    were given against a schema that no longer exists and the whole draft is
   *    refused. Validating against the new schema instead would silently discard
   *    an answer to a renamed attribute — data loss with no error.
   * 3. **The store writes, and re-checks the version as it pins.** This service
   *    cannot close the window between its own read and the write; the store
   *    can, because it pins inside the same statement.
   *
   * The category version itself is still never chosen by a caller — see
   * `ListingDraft`. What travels is an assertion about what was read, which the
   * write refuses to honour if it has stopped being true.
   */
  async createDraft(submitted: SubmittedListing): Promise<ListingRecord> {
    const category = await this.categories.findOption(submitted.categorySlug);
    if (category === null) throw new UnknownCategoryError(submitted.categorySlug);

    if (category.versionNumber !== submitted.categoryVersionNumber) {
      throw new CategoryChangedError(
        submitted.categorySlug,
        submitted.categoryVersionNumber,
        category.versionNumber,
      );
    }

    const values = validateAttributeValues(category.attributes, submitted.attributes);
    if (!values.ok) throw new AttributeValuesInvalidError(values.issues);

    return this.store.createDraft({
      ownerId: submitted.ownerId,
      categorySlug: submitted.categorySlug,
      title: submitted.title,
      description: submitted.description,
      replacementValue: submitted.replacementValue,
      attributes: values.values,
      categoryVersionNumber: category.versionNumber,
    });
  }

  /**
   * One of this owner's listings.
   *
   * Ownership is the store's query, not a comparison made here. Resolves to null
   * for both "no such listing" and "not yours", so the route cannot leak the
   * difference even by accident.
   */
  findOwned(id: string, ownerId: string): Promise<ListingRecord | null> {
    return this.store.findOwnedBy(id, ownerId);
  }

  /** The categories an owner may list in, with the fields each one asks for. */
  categoryOptions(): Promise<readonly CategoryOptionRecord[]> {
    return this.categories.listOptions();
  }
}
