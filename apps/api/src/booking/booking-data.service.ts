import { Paging, Time } from '@platform/core';
import type { ExportedBookingsSection } from '@platform/contracts';
import type { BookingRecord, BookingStore } from './booking-store.js';
import type { ExportableQuote, QuoteStore } from './quote-store.js';

/**
 * How much of each array a subject-access response carries.
 *
 * **An engineering bound on one query, not a page size** (ADR 0035). It is set
 * far above any plausible number of hires, so `truncated` is false for everybody
 * until somebody is genuinely extraordinary — and for that person it is the
 * difference between a document that is wrong and one that is short and says so.
 *
 * **Deliberately not shared with `DEFAULT_BOOKING_LIST_LIMIT`.** That one is a
 * page a person scrolls on a dashboard; this one is a guardrail on a legal
 * artefact, and a constant two callers import is one that cannot be changed for
 * either of them.
 */
export const EXPORTED_BOOKING_LIMIT = 500;

/**
 * Booking's contribution to somebody's data export (BRD §10.1, slice 4.8d).
 *
 * **The module could be erased and not exported, which is exactly the asymmetry
 * `PersonalDataSource` exists to make obvious.** 4.4b gave Booking a
 * `PersonalDataEraser` for the renter's postcode on a quote and stopped there, so
 * that postcode was deletable on request and absent from the answer to *what do
 * you hold about me*. The two ports sit side by side in `identity/` precisely so
 * adding one without the other feels incomplete; it did not feel incomplete
 * enough, and the gap stood for two days.
 *
 * ## Three arrays, because they answer to different rules
 *
 * **`hires`** — what this person asked to rent. Theirs, and carrying the postcode
 * they gave, which is the personal datum this whole section exists for.
 *
 * **`lettings`** — what other people booked on their listings. A record about
 * them too: what their item did and what it earned. **It carries nothing about
 * the renter** — not a name, not a postcode — because the counterparty's address
 * is not this person's data and §8.4.1's posture is that identity arrives with
 * commitment.
 *
 * **`quotes`** — prices they were given that became nothing. **Exactly the rows
 * erasure takes**, which is what makes this a mirror of the eraser rather than a
 * second view of it: what appears here disappears when the account does, and what
 * is in `hires` is kept because the terms belong to the counterparty too. §10.1
 * requires the deletion workflow to explain what survives, and this is the half
 * that does not.
 *
 * **Nothing here is audited.** `AccountDataService` records the export once, as a
 * disclosure; a second entry per contributing module would bury that trail in
 * noise. The rule `ProfileService` and Catalogue both follow.
 */
export class BookingDataService {
  constructor(
    private readonly bookings: BookingStore,
    private readonly quotes: QuoteStore,
  ) {}

  async exportFor(userId: string): Promise<ExportedBookingsSection> {
    /*
     * **The two booking reads are 4.8a's, reused rather than rewritten.** They
     * are already bounded, already ordered newest-first with a total order, and
     * already scoped in the query — three properties this section needs and none
     * of which a second pair of methods would inherit for free.
     */
    const probe = Paging.probe(EXPORTED_BOOKING_LIMIT);
    const [hireRows, lettingRows, quoteRows] = await Promise.all([
      this.bookings.findForRenter(userId, probe),
      this.bookings.findForOwner(userId, probe),
      this.quotes.listUnbookedForRenter(userId, probe),
    ]);

    const hires = Paging.fitTo(hireRows, EXPORTED_BOOKING_LIMIT);
    const lettings = Paging.fitTo(lettingRows, EXPORTED_BOOKING_LIMIT);
    const quotes = Paging.fitTo(quoteRows, EXPORTED_BOOKING_LIMIT);

    /*
     * **The postcodes come in one read, keyed by quote.** A hire's postcode lives
     * on the quote it was priced from — `bookings` copies the money and the
     * item's name (§8.2) and deliberately not the address — so it has to be
     * fetched, and fetching it per hire would be five hundred queries on the
     * export path.
     *
     * **Scoped by renter as well as by id**, in the store. The lettings below
     * carry no postcode at all, and the scope is what makes that a property of
     * the query rather than of this file remembering.
     */
    const postcodes = await this.quotes.postcodesFor(
      hires.items.map((booking) => booking.quoteId),
      userId,
    );

    return {
      hires: hires.items.map((booking) => toHire(booking, postcodes)),
      lettings: lettings.items.map(toLetting),
      quotes: quotes.items.map(toQuote),
      /*
       * **One flag for three arrays.** A person who has hit the bound on any of
       * them is owed the same sentence — *this is not all of it* — and three
       * flags would be three ways to say one thing, each of which a reader has to
       * check separately.
       */
      truncated: hires.truncated || lettings.truncated || quotes.truncated,
    };
  }
}

/**
 * The inclusive last day, from the exclusive bound the column holds.
 *
 * The same conversion every booking projection performs. Stated here rather than
 * imported from `bookings.service.ts` because that one is private to it; the two
 * are pinned to the same answer by the tests either side.
 */
function inclusiveEnd(endAt: Date): string {
  return Time.addLocalDays(Time.toLocalDateString(endAt), -1);
}

function toHire(
  booking: BookingRecord,
  postcodes: ReadonlyMap<string, string>,
): ExportedBookingsSection['hires'][number] {
  return {
    id: booking.id,
    state: booking.state,
    startDate: Time.toLocalDateString(booking.startAt),
    endDate: inclusiveEnd(booking.endAt),
    itemTitle: booking.itemTitle,
    categoryName: booking.categoryName,
    total: booking.total,
    /*
     * **Null only for a quote that is gone, which cannot happen today.**
     * `bookings.quoteId` is `RESTRICT` and a booked quote is deliberately kept on
     * erasure, so the lookup always finds one. It is nullable rather than
     * asserted because a missing postcode is a fact worth stating plainly in a
     * legal document, and `?? ''` would state a false one.
     */
    collectionPostcode: postcodes.get(booking.quoteId) ?? null,
    createdAt: Time.toIsoUtc(booking.createdAt),
  };
}

function toLetting(
  booking: BookingRecord,
): ExportedBookingsSection['lettings'][number] {
  return {
    id: booking.id,
    listingId: booking.listingId,
    state: booking.state,
    startDate: Time.toLocalDateString(booking.startAt),
    endDate: inclusiveEnd(booking.endAt),
    itemTitle: booking.itemTitle,
    // The owner's own money. No payout: §3.4's commission arithmetic is Phase 5,
    // and a figure labelled as what they received would be false in a document
    // somebody may rely on.
    itemCharge: booking.itemCharge,
    createdAt: Time.toIsoUtc(booking.createdAt),
  };
}

function toQuote(quote: ExportableQuote): ExportedBookingsSection['quotes'][number] {
  return {
    id: quote.id,
    startDate: Time.toLocalDateString(quote.startAt),
    endDate: inclusiveEnd(quote.endAt),
    itemTitle: quote.itemTitle,
    total: quote.total,
    collectionPostcode: quote.renterPostcode,
    createdAt: Time.toIsoUtc(quote.createdAt),
    expiresAt: Time.toIsoUtc(quote.expiresAt),
  };
}
