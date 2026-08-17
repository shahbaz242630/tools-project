import type { CategoryFeePolicy, ListingRateCard } from '@platform/contracts';

/**
 * What Booking needs to know about a listing in order to price it (slice 4.4b).
 *
 * **The second port Booking declares and Catalogue answers**, after 4.3b's
 * `ListingOwnership`. Same reason: a quote has to know what an item costs and
 * what its category permits, and Booking may not read the `listings` table to
 * find out (BRD §5.1).
 *
 * **Narrower than a listing, and every omission is deliberate.** There is no
 * description, no attribute values and — above all — no collection address. A
 * port returning the whole record would put a decrypted street line inside a
 * module that has no reason to hold one, and every later caller here would have
 * one to hand without having needed it. That is how a projection leaks.
 * `ListingOwnership` makes the same argument for returning a boolean.
 *
 * **It gained the item's name in 4.5a, having deliberately had none in 4.4b**, and
 * the reason is §8.2 rather than convenience: a booking **copies** what was hired
 * so its history stays readable after the listing is retitled or erased, and the
 * words have to come from somewhere. An address still does not, which is the line
 * this port draws — what crosses is what a booking record must contain, not
 * everything a listing knows.
 *
 * **The name still says "quote" although a booking reads it too**, and that is a
 * judgement rather than an oversight: everything bookable is quotable and a
 * booking is made from a quote, so the two questions have one answer. Renaming it
 * would touch 4.4b's files for no change in behaviour, and a second port with
 * overlapping fields would be worse — two places for "what may be booked" to be
 * decided.
 *
 * **It answers only about listings a stranger could book.** Null covers a
 * listing that does not exist, one that is not published, one the platform has
 * hidden, and one whose owner has not declared themselves a private individual —
 * four different facts collapsed into one, because a renter must not be able to
 * tell them apart. The rule itself stays in Catalogue, where the two visibility
 * columns and the owner declaration live (ADR 0041, slice 2.13); restating it
 * here would be a second copy of a rule that has already been got wrong once.
 */
export interface QuotableListing {
  readonly id: string;
  /**
   * Who owns it.
   *
   * **Here for one purpose: refusing to quote somebody their own item.** It is
   * not a display field and nothing renders it. §7 has no state for a hire from
   * yourself, and a booking whose renter and owner are the same person would put
   * one person on both sides of a payout.
   */
  readonly ownerId: string;
  /**
   * What was hired and what kind of thing it is, for the copy a booking keeps
   * (§8.2, slice 4.5a).
   *
   * **Read at the moment of booking and then never again**, which is the whole
   * point: a booking that rendered its item by joining the listing would show a
   * retitled item for last month's hire, or nothing at all once the owner has
   * left.
   */
  readonly title: string;
  readonly categoryName: string;
  /** What the owner charges (§8.5.2). The daily rate is the spine. */
  readonly rates: ListingRateCard;
  /**
   * The fee policy **as it stands now** (ADR 0042), not as the listing pinned it.
   *
   * A listing is not a contract — the price in the shop window is the price
   * payable today. The quote pins this by storing the version id below.
   */
  readonly currentFeePolicy: CategoryFeePolicy;
  /**
   * The longest hire the category permits **as it stands now** (§8.5.3).
   *
   * **Current rather than pinned, and this is a decision slice 4.4b had to
   * make.** `rental-period.ts` was written expecting the listing's pinned cap, on
   * the reasoning that a booking is judged against the cap it was made under.
   * That reasoning is right about *reading history* and wrong about *making a new
   * hire*: ADR 0042's distinction is that a pinned version gives stored answers
   * their **meaning** — `25` is 2.5 kg — while a **rule** about what may happen
   * now comes from the current version, which is why the fee policy above does.
   * A duration cap is a rule, and a legal one: an administrator who narrows a
   * category to thirty days has to affect the next hire, not only the hires of
   * listings whose owners happen to edit them.
   *
   * The version id below is what keeps history honest, because it records which
   * cap this quote was actually judged against.
   */
  readonly currentMaximumRentalDays: number;
  /**
   * How long the owner has to answer a request, in hours (§8.6, slice 4.5a).
   *
   * Current rather than pinned, for the same reason the cap above is: it is a rule
   * about what may happen now. A request records the deadline it was given, so
   * changing this cannot move one already made.
   */
  readonly currentRequestExpiryHours: number;
  /** The version the `current` fields above came from (§8.5.2). */
  readonly currentCategoryVersionId: string;
}

export interface ListingQuoteSource {
  /**
   * The listing, if it is one this renter could book, or null.
   *
   * **Null is not an error and must not become one.** See the four facts it
   * covers, above.
   */
  findQuotable(listingId: string): Promise<QuotableListing | null>;
}
