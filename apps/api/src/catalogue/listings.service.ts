import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  ListingDraft,
  ListingRecord,
  ListingStore,
} from './listing-store.js';

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
   * The category version is pinned by the store, from the slug, at the moment
   * the row is written — see `ListingDraft`. This service deliberately does not
   * read the category first and hand down an id: that would open a window
   * between reading and writing in which a reconfiguration could land, and the
   * listing would then claim to have been written against a version it never
   * saw.
   */
  createDraft(draft: ListingDraft): Promise<ListingRecord> {
    return this.store.createDraft(draft);
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

  /** The categories an owner may list in. */
  categoryOptions(): Promise<readonly CategoryOptionRecord[]> {
    return this.categories.listOptions();
  }
}
