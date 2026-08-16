/**
 * Which of these listings something has been booked against (slice 4.2).
 *
 * **Stated by Catalogue, answered by Booking** — the same direction as
 * `ListingProximity` and `OwnerStatusSource`, and the same reason: Catalogue
 * owns listings and must not read another module's table (BRD §5.1). The
 * composition root wires the two together.
 *
 * **It exists for one question and should stay that narrow.** Erasing an
 * account has to know which of its listings a booking points at, because those
 * two cases are erased differently — see `ListingStore.eraseOwnedBy`. Anything
 * else Catalogue might want to know about a booking is a different port, or
 * more likely a domain event.
 *
 * **A set of ids and nothing else.** Not a count, not the bookings, not their
 * states: the answer to *"may I delete this row"* is a yes or a no, and every
 * extra field is one the erasure path would have to be trusted not to leak into
 * an audit entry or a log line about somebody else's rental.
 */
export interface BookingReferences {
  /**
   * The subset of `listingIds` that at least one booking refers to.
   *
   * **Every state counts, including the terminal and the declined ones**, and
   * that is the decision rather than an oversight. A `DECLINED` request is
   * still a record of somebody having asked, a `CANCELLED` booking may have
   * money attached, and §10.1's carve-out is about records the platform must
   * retain rather than about bookings that went well. Narrowing this to "live"
   * bookings would delete the listing under a renter's completed history, which
   * is exactly what the carve-out exists to prevent.
   *
   * **Ids that refer to no listing at all are simply absent from the result**,
   * rather than being an error: the caller is asking which of a set to keep,
   * and a set it built itself from its own rows cannot contain a surprise.
   */
  findBookedListings(listingIds: readonly string[]): Promise<ReadonlySet<string>>;
}
