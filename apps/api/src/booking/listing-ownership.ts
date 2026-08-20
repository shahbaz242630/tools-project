/**
 * Whose listing this is (slice 4.3b).
 *
 * **Stated by Booking, answered by Catalogue — the first port that crosses this
 * boundary in that direction.** The three that existed before it all point the
 * other way: `ListingProximity`, `OwnerStatusSource` and `BookingReferences` are
 * declared by Catalogue and answered by somebody else. This one is Booking
 * saying what it needs, and BRD §5.1 is the whole reason it exists rather than a
 * `prisma.listing.findFirst` three lines into the availability service.
 *
 * **A boolean, not a listing.** The calendar's question is *may this person
 * manage these dates*, and the answer to that is one bit. A port returning the
 * record would put a decrypted street address inside a module whose subject is
 * time — and every later caller here would have one to hand without having
 * needed it, which is how a projection leaks.
 *
 * **It deliberately says nothing about status or moderation.** An owner may
 * block dates on a draft, on a paused listing and on one the platform has
 * hidden; none of that is this port's business, and a port that folded
 * visibility into ownership would give the two rules one name (ADR 0041).
 */
export interface ListingOwnership {
  /**
   * True when this listing exists and belongs to this owner.
   *
   * **False covers both "not yours" and "no such listing", and the caller must
   * keep them indistinguishable** — the rule every owner-scoped read in this
   * project follows. Answering 403 for the first and 404 for the second
   * confirms the existence of a listing the check was there to protect.
   */
  isOwnedBy(listingId: string, ownerId: string): Promise<boolean>;

  /**
   * Who owns this listing, or null if there is no such listing (slice 5.2c).
   *
   * **It exists for one reason: somebody has to be paid.** `bookings` keeps no
   * `ownerId` column, deliberately — the schema says a copy *"would create a row
   * that can disagree with itself about who is owed the money"* — so when a hire
   * is charged the payee has to be asked for.
   *
   * **This port rather than `ListingQuoteSource`, and the difference is the whole
   * point.** That one answers only about listings a stranger could book, and
   * returns null for a paused or hidden one. An owner who accepts a booking and
   * then pauses their listing to stop new enquiries must not thereby make the
   * hire unpayable — and this port's own promise, above, is that it says nothing
   * about status or moderation. Using the wrong one would be a bug nobody meets
   * until an owner does something entirely reasonable.
   *
   * **An id and nothing else**, which keeps the argument this port opens with:
   * returning the listing would put a collection address inside a module whose
   * subject is time and money.
   */
  ownerOf(listingId: string): Promise<string | null>;
}
