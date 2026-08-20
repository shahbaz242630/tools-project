import type { CategoryFeePolicy } from '@platform/contracts';

/**
 * The fee policy a booking was actually made under (BRD §8.2, slice 5.2b).
 *
 * **Stated by Payments, answered by Catalogue** — the same direction as
 * `ListingOwnership` and `ListingQuoteSource`, and the same reason: Catalogue
 * owns `category_versions` and BRD §5.1 forbids another module reading its
 * tables.
 *
 * **It exists because 5.2a found a gap and named it.** `ListingQuoteSource`
 * hands out `currentFeePolicy` — the right answer for pricing a *new* hire,
 * because a listing is not a contract and the price in the shop window is the
 * price payable today (ADR 0042). Settlement is the opposite question. §8.2
 * requires a booking to be readable under the terms it was made under, and
 * `settleHire` says so in as many words: *"re-reading today's commission would
 * pay an owner a rate nobody agreed to."* Nothing exposed the pinned one, so
 * settlement had no honest input. This is that input.
 *
 * **A version id rather than a booking id**, so nothing about Payments' question
 * requires Catalogue to know what a booking is. `bookings.categoryVersionId`
 * exists precisely to be carried here, and `category_versions` is immutable — a
 * trigger refuses UPDATE — so the answer is the same in eighteen months as it is
 * today. That immutability is what makes this provable rather than merely
 * recorded.
 *
 * **Narrower than a category version, and the omissions are deliberate.** No
 * name, no attribute schema, no risk level, no duration cap. Payments settles
 * money and has no business rendering a category or judging a hire's length; a
 * port returning the whole row would put all of that within reach of every later
 * caller here without any of them having needed it. `ListingQuoteSource` makes
 * the same argument at greater length.
 */
export interface CategoryFeePolicySource {
  /**
   * The fee policy on this exact category version, or null if there is no such
   * version.
   *
   * **Null must never be treated as "use the current one".** A booking whose
   * pinned version cannot be found is a booking we cannot settle honestly, and
   * falling back to today's rates would pay somebody a number they never agreed
   * to — quietly, and correctly as far as every test is concerned. Refusing is
   * the only safe answer, and `PaymentsService` refuses.
   *
   * It is not expected to happen: the column is a foreign key and the row is
   * immutable. It is typed as nullable because the alternative is an adapter
   * that throws its own error shape into a service that has no way to tell that
   * case from a database outage.
   */
  findFeePolicy(categoryVersionId: string): Promise<CategoryFeePolicy | null>;
}
