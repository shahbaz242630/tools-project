/**
 * Taking the money for a hire, as Booking asks for it (BRD §5.1, §8.7, slice
 * 5.2c).
 *
 * **Stated by Booking, answered by Payments** — the third port pointing this way,
 * after `ListingOwnership` and `ListingQuoteSource`, and the reason is the same:
 * BRD §5.1 gives Payments & Ledger the money and forbids Booking holding
 * *"provider-specific payment code"*. A booking knows what it costs and who is
 * owed it; what happens to a card is somebody else's subject.
 *
 * **The types here are Booking's own, and the duplication with `payments/` is
 * deliberate.** `ProximitySearch` and `NearbySearch` are structurally identical
 * for exactly this reason: one module states what it needs, the other states what
 * it offers, and neither imports the other. The composition root hands one to the
 * other, so a field added on one side and forgotten on the other is a **compile
 * error at the seam** rather than an `undefined` arriving somewhere quiet.
 *
 * **It says nothing about a card, a provider, an intent or an idempotency key.**
 * Those are all real and all Payments', and a port carrying any of them would put
 * a provider's object model inside the booking machine — which is the thing
 * ADR 0051 exists to prevent.
 */

/** What a hire costs and who is owed it, from the booking's own row (§8.2). */
export interface HireChargeRequest {
  readonly bookingId: string;
  /**
   * Who is owed the proceeds.
   *
   * **Not on the booking row**, deliberately — `bookings` keeps no `ownerId`
   * because a copy could disagree with the listing about who is paid. It comes
   * from `ListingOwnership.ownerOf`, which answers regardless of whether the
   * listing is still published.
   */
  readonly ownerId: string;
  /** The version whose fee policy divides it — pinned when the booking was made. */
  readonly categoryVersionId: string;
  /**
   * What was hired, for the payer's statement.
   *
   * The **stored** title (§8.2), so a statement reads the same in a year as it
   * did on the day, and never an address (§8.4.1).
   */
  readonly itemTitle: string;
  /** The money, copied onto the booking when it was made and never re-derived. */
  readonly itemCharge: { readonly amount: number; readonly currency: string };
  readonly renterFee: { readonly amount: number; readonly currency: string };
  readonly total: { readonly amount: number; readonly currency: string };
}

/**
 * What the payer must do next, if anything.
 *
 * **Passed through and never stored.** It is a short-lived bearer value the
 * provider's own browser library consumes; nothing here reads it, branches on it
 * or writes it down, and no log line or metric label may carry it.
 */
export interface HirePayerAction {
  readonly kind: 'confirm_in_browser';
  readonly token: string;
}

/**
 * Where the charge got to.
 *
 * **Four values, and the first two are not the same thing.** Strong Customer
 * Authentication means a UK card payment usually cannot resolve in one call:
 * `pending_payer_action` means there is a challenge and a token for the browser,
 * `processing` means there is nothing to do but wait. Both leave the booking in
 * `AWAITING_PAYMENT` — §7 already had that state — and collapsing them loses the
 * token, which is the whole reason the renter can finish.
 */
export type HireChargeStatus =
  'pending_payer_action' | 'processing' | 'succeeded' | 'failed';

/** What came back. */
export interface HireChargeResult {
  readonly status: HireChargeStatus;
  /** Present only when the status is `pending_payer_action`. */
  readonly payerAction?: HirePayerAction;
  /**
   * A sentence for the payer, present only when the status is `failed`.
   *
   * **A sentence and not a code.** Payments categorises a failure for its own
   * reconciliation; a renter cannot act on the difference between a decline and a
   * failed authentication — both mean *try again or use another card* — and
   * projecting the category would put a vocabulary on the wire that nothing needs
   * and everything would then have to keep.
   */
  readonly failureMessage?: string;
}

export interface HirePayments {
  /**
   * Take the hire charge, or say what the payer must do.
   *
   * **Idempotent per booking, and Booking relies on that rather than guarding
   * it.** Pressing pay twice, or resuming after a crash, must charge once — the
   * attempt key is derived inside Payments from the booking and how many attempts
   * have already failed, so a repeat presents the same key and returns the same
   * attempt. That is why this takes no key: a key invented here would be a second
   * place for the rule to live, and the browser is the worst possible place for
   * the first.
   */
  chargeForHire(request: HireChargeRequest): Promise<HireChargeResult>;
}
