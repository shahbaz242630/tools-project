import type { MoneyValue } from '@platform/core';
import type { QuoteLineItem } from '@platform/contracts';

/**
 * How quotes are written and read (BRD §8.5.2, slice 4.4b).
 *
 * **Write and read, and deliberately no update.** §8.5.2 makes a quote a firm
 * offer with an expiry; re-pricing is issuing another one. A port with an update
 * method is an invitation to change a price somebody was shown, which is the one
 * thing storing it was meant to prevent — the same reasoning `AuditLog` uses for
 * having no update method at all.
 */

/** A quote, as this module writes one. */
export interface NewQuote {
  readonly listingId: string;
  readonly renterId: string;
  readonly startAt: Date;
  /** Exclusive — the first moment after the hire. See `local-period.ts`. */
  readonly endAt: Date;
  /**
   * The zone the hire was counted in (ADR 0003).
   *
   * Required rather than defaulted, exactly as on `NewBooking`: a default is a
   * caller that never had to think about it, and the one thing ADR 0003 asks of
   * every later reader is that they know a rental day is a local calendar day.
   */
  readonly timeZone: string;
  /** Normalised on the way in by `postcodeSchema` (§8.5.2). */
  readonly renterPostcode: string;
  readonly itemCharge: MoneyValue;
  readonly renterFee: MoneyValue;
  readonly total: MoneyValue;
  readonly minimumFeeApplied: boolean;
  readonly lineItems: readonly QuoteLineItem[];
  /**
   * The category version whose fee policy priced this (§8.5.2's *category
   * version*).
   *
   * **The current version, not the listing's pinned one** (ADR 0042): a listing
   * displays the price payable today, so that is the policy a quote is built
   * from — and storing which version it was is what makes the quote reproducible
   * afterwards.
   */
  readonly categoryVersionId: string;
  readonly expiresAt: Date;
}

/** A quote, as this module reads one back. */
export interface QuoteRecord extends NewQuote {
  readonly id: string;
  readonly createdAt: Date;
}

export interface QuoteStore {
  create(quote: NewQuote): Promise<QuoteRecord>;

  /**
   * One quote belonging to this renter, or null.
   *
   * **Scoped by renter in the query rather than compared afterwards**, the rule
   * every owner-scoped read in this project follows. Null covers both "no such
   * quote" and "not yours", and the caller must keep them indistinguishable —
   * answering differently would confirm that a quote id exists.
   *
   * **It does not filter out expired quotes.** Whether an expired quote may
   * still be acted on is a decision, and it belongs where the clock is injected;
   * a store that silently hid them would make "expired" and "never existed" the
   * same fact, and 4.5 has to tell a renter which of the two happened.
   */
  findForRenter(id: string, renterId: string): Promise<QuoteRecord | null>;

  /**
   * Delete every quote belonging to this renter, and answer how many.
   *
   * **This is account erasure, and the foreign key cannot do it.**
   * `quotes.renterId` is `ON DELETE CASCADE`, which looks like it settles the
   * question — but accounts are **soft-deleted** with a tombstoned email
   * (ADR 0018), so the `users` row survives and the cascade never fires. A
   * reader who trusted the schema would leave a postcode and a date range behind
   * for every quote the account ever asked for.
   *
   * **Idempotent**, which `PersonalDataEraser` requires: erasing what is already
   * gone is a success, so a retry after a partial failure can finish the job.
   *
   * **From 4.5 this becomes conditional.** A quote a booking was made from is
   * part of that booking's terms and belongs to the counterparty as much as to
   * the renter, so it will be kept while the booking exists — the product
   * owner's decision of 17 August 2026, and the same inversion 4.2 performed
   * when `deleteAllOwnedBy` became `eraseOwnedBy`.
   */
  deleteAllForRenter(renterId: string): Promise<number>;
}
