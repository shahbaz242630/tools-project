import type {
  NewPaymentIntent,
  PaymentIntentOutcome,
  PaymentIntentRecord,
} from './payment-intent.js';

/**
 * How payment attempts are written and read (BRD §6.2, §8.7, slice 5.2b).
 *
 * **This port has an update method and the ledger's deliberately does not.**
 * `LedgerStore` omits one because §8.7 says corrections are made *"only by
 * posting reversing entries, never by editing or deleting"*; an attempt is not a
 * financial record but a mirror of something moving at another company, and it
 * changes. Keeping the two ports in one module with opposite shapes is the point
 * — the immutability rule attaches to the books, not to everything money
 * touches.
 *
 * **No delete, though.** An abandoned attempt is evidence that somebody tried to
 * pay, and §10.1 keeps financial records for six years. Nothing here removes a
 * row, and the retention that eventually does is a reviewed migration.
 */
export interface PaymentIntentStore {
  /**
   * Open an attempt, or return the one this key already opened.
   *
   * **Get-or-create on `attemptKey`, and that is the double-press guard.** A
   * renter who presses pay twice presents the same key; the second call finds
   * the row and the service makes no second provider call. Implementations must
   * be safe against two callers racing — the unique index on `attemptKey` is
   * what makes that possible, and `PrismaLedgerStore` records what happens when
   * an adapter assumes Prisma's `upsert` is atomic and it is not.
   */
  begin(intent: NewPaymentIntent): Promise<PaymentIntentRecord>;

  /**
   * Write what the provider said.
   *
   * The caller has already asked {@link dispositionOf} whether the outcome may
   * be applied; this writes it. It does **not** re-decide, because the two
   * places would then disagree about a rule that decides whether money is
   * recorded.
   */
  recordOutcome(
    intentId: string,
    outcome: PaymentIntentOutcome,
  ): Promise<PaymentIntentRecord>;

  findById(id: string): Promise<PaymentIntentRecord | null>;

  /**
   * Every attempt against one booking, newest first.
   *
   * **Plural because retries are ordinary.** A declined card is followed by a
   * second attempt, and both are part of the answer to *"has this been paid
   * for"* — a method returning "the" intent would have to pick one, and the
   * picking is the caller's business rather than the store's.
   */
  findForBooking(bookingId: string): Promise<readonly PaymentIntentRecord[]>;
}
