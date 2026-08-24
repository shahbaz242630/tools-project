/**
 * How a listing's photographs are erased with it (slice 2.6b-i).
 *
 * **A port declared by `ListingsService` and answered by `ListingMediaService`,
 * though both live in Catalogue.** Not every port here crosses a module
 * boundary — this one narrows a collaborator to the single thing the erasure
 * path is entitled to ask, so that a later edit cannot reach `add` or `reorder`
 * from a §10.1 obligation.
 */
export interface ListingMediaEraser {
  /**
   * Delete every photograph of these listings, bytes first, then rows.
   *
   * **Idempotent**, as `PersonalDataEraser` requires: called twice, the second
   * call finds nothing and succeeds, because a retry after a partial failure has
   * to be able to finish the job.
   *
   * **Never throws for a storage failure.** Account deletion is a statutory
   * obligation and must not fail because a bucket was briefly unreachable; the
   * implementation records what it could not delete and carries on.
   */
  eraseForListings(listingIds: readonly string[]): Promise<void>;
}
