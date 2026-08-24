/**
 * Where a listing's photographs are recorded (slice 2.6b-i).
 *
 * **Its own port rather than more methods on `ListingStore`**, and the reason is
 * the rule that port already states: *"every read here is scoped by owner, and
 * that is the design"*. Media reads are scoped by **listing**, because the
 * listing is what proves the ownership — a media row has no owner column and
 * adding one would be a second place for the same fact to live, and the easier
 * of the two to get wrong.
 *
 * So a caller must establish ownership before it gets here, through
 * `ListingStore.existsOwnedBy`. This port takes that as already settled and
 * never re-derives it. That is a real division of responsibility rather than an
 * oversight, and it is why nothing here takes an `ownerId`.
 */

/** One photograph as it is stored. */
export interface ListingMediaRecord {
  readonly id: string;
  readonly listingId: string;
  readonly position: number;
  readonly displayKey: string;
  readonly thumbnailKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly thumbnailWidth: number;
  readonly thumbnailHeight: number;
  readonly sha256: string;
  readonly moderationState: string;
  readonly createdAt: Date;
}

/**
 * A photograph about to be recorded.
 *
 * A named object rather than positional arguments: eleven fields, six of them
 * numbers and four of them strings, is `add(id, key, key, type, size, w, h, ...)`
 * — a call nothing would catch being wrong. The same argument
 * `ModerationDecision` makes for three.
 */
export interface NewListingMedia {
  readonly listingId: string;
  readonly displayKey: string;
  readonly thumbnailKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly thumbnailWidth: number;
  readonly thumbnailHeight: number;
  readonly sha256: string;
}

export interface ListingMediaStore {
  /**
   * This listing's photographs, in the owner's order.
   *
   * Ordered by `(position, createdAt, id)` — **a total order whatever the data
   * says**, which is what makes the absent unique constraint on
   * `(listingId, position)` safe. Duplicate positions are representable; two
   * rows sharing one still come back in the same sequence every time.
   */
  listFor(listingId: string): Promise<readonly ListingMediaRecord[]>;

  /**
   * Record a photograph at the end of the listing's order.
   *
   * **The position is chosen here rather than by the caller**, because choosing
   * it means reading the current maximum, and a caller that reads then writes
   * has a race between the two. It is still not serialisable — two simultaneous
   * uploads can pick the same position — and that is precisely the case the
   * missing unique constraint makes harmless rather than fatal: both rows exist,
   * both are reachable, and the order between them is decided by `createdAt`.
   */
  append(media: NewListingMedia): Promise<ListingMediaRecord>;

  /**
   * Remove one photograph, returning what it was so the caller can delete the
   * objects — or null if this listing has no such media.
   *
   * **Returns the record rather than void**, because the storage keys are the
   * only handle on the bytes and reading them after the row is gone is
   * impossible. The caller deletes the objects *after* this succeeds: a failed
   * object delete then leaks bytes, which is the recoverable direction, where
   * deleting objects first and failing to delete the row would leave a row
   * pointing at nothing.
   *
   * Note this is the opposite order from erasure, deliberately — see
   * `deleteFor`. The difference is that here the row is the record of a leak we
   * could clean up later, and there the row is personal data that must not
   * survive.
   */
  remove(listingId: string, mediaId: string): Promise<ListingMediaRecord | null>;

  /**
   * Put this listing's photographs in this order.
   *
   * The whole list, applied in one transaction. `mediaIds` must be exactly the
   * ids this listing holds — the service checks that, because it is the layer
   * that can return a useful refusal, and this method assumes it.
   */
  reorder(listingId: string, mediaIds: readonly string[]): Promise<void>;

  /**
   * Every photograph belonging to any of these listings.
   *
   * **Plural because erasure is**, and because the alternative is a query per
   * listing inside a loop that already knows the whole set. `eraseFor` uses it
   * to collect the storage keys before anything is deleted.
   */
  listForListings(
    listingIds: readonly string[],
  ): Promise<readonly ListingMediaRecord[]>;

  /**
   * Delete every photograph of these listings.
   *
   * **For the erasure path, and it is why this method exists at all** — the
   * cascade from `listings` already covers a listing being *deleted*. §10.1
   * keeps a listing a booking references, collapsing it rather than removing it,
   * and the cascade never fires for those. A photograph of somebody's garden,
   * driveway or front door is the owner's personal data and not the renter's
   * record of what they hired, so it goes in both branches.
   *
   * **Idempotent**, as `PersonalDataEraser` requires: deleting what is already
   * gone succeeds, because a retry after a partial failure has to finish.
   */
  deleteFor(listingIds: readonly string[]): Promise<void>;
}
