/**
 * Securing a handover, as Booking asks for it (BRD §5.1, §8.7.2, slice 5.5c-ii).
 *
 * **Stated by Booking, answered by Payments** — the fourth port pointing this
 * way, after `ListingOwnership`, `ListingQuoteSource` and `HirePayments`, and the
 * reason is `HirePayments`': BRD §5.1 gives Payments & Ledger the money and
 * forbids Booking holding *"provider-specific payment code"*.
 *
 * **The types are Booking's own and the duplication with `payments/` is
 * deliberate**, exactly as `HirePayments` explains: one module states what it
 * needs, the other states what it offers, neither imports the other, and the
 * composition root joins them — so a field added on one side and forgotten on the
 * other is a compile error at the seam rather than an `undefined` arriving
 * somewhere quiet.
 *
 * **It says nothing about a card, an authorisation, an expiry or an intent.** All
 * of those are real and all of them are Payments'. §8.7.2's `capture_before` in
 * particular is deliberately absent: Booking never decides anything from it, and
 * a port carrying it would invite something here to start.
 */

/** What is being secured, from the booking's own row (§8.2). */
export interface CollectionSecurityRequest {
  readonly bookingId: string;
  /**
   * Who would be paid from a claim against the hold.
   *
   * **Not on the booking row**, for `HireChargeRequest.ownerId`'s reason — a copy
   * could disagree with the listing about who is paid. It comes from
   * `ListingOwnership.ownerOf`.
   */
  readonly ownerId: string;
  /** The version whose band sized the excess — pinned when the booking was made. */
  readonly categoryVersionId: string;
  /**
   * What is being secured, for the payer's statement. The **stored** title
   * (§8.2), never an address (§8.4.1).
   */
  readonly itemTitle: string;
  /**
   * §8.7.2's applied excess as the booking stored it, or `null` where the
   * category requires no security at all.
   *
   * **Passed through rather than interpreted here** ([ADR 0052](../../../../adr/0052-the-applied-excess-is-capped-and-an-unset-band-means-no-security.md)).
   * Booking hands over what its row says and Payments decides what it means, so
   * the rule that an absent excess is a configured answer lives in exactly one
   * module. Booking re-implementing it would be a second copy, and the copies
   * would agree right up until one of them was amended.
   */
  readonly excess: { readonly amount: number; readonly currency: string } | null;
}

/**
 * How securing a handover turned out.
 *
 * **Four values, and only one of them is a failure.** §8.7.2 requires a
 * deliberately unsecured handover and a broken one to be told apart, because they
 * call for opposite decisions about handing somebody's property over — so
 * `not_required` is its own answer and never collapses into `failed`.
 *
 * `pending_payer_action` is here for the same reason it is on `HireChargeStatus`:
 * Strong Customer Authentication applies to an authorisation as it does to a
 * charge, so a hold can legitimately be *unfinished*. **Unfinished is not
 * failed** — a booking whose renter is halfway through a challenge must not be
 * marked `SECURITY_FAILED`, which is a state that says we tried and could not.
 */
export type CollectionSecurityStatus =
  /** The category holds nothing, or its band sizes this booking's excess at zero. */
  | 'not_required'
  /** The excess is authorised against the renter's card. */
  | 'held'
  /** The renter has a challenge to finish. Nothing has failed. */
  | 'pending_payer_action'
  /** The hold was attempted and refused. */
  | 'failed';

/** What the payer must do next, if anything. Passed through, never stored. */
export interface SecurityPayerAction {
  readonly kind: 'confirm_in_browser';
  readonly token: string;
}

/** What came back. */
export interface CollectionSecurityResult {
  readonly status: CollectionSecurityStatus;
  /** Present only when the status is `pending_payer_action`. */
  readonly payerAction?: SecurityPayerAction;
  /**
   * A sentence for the payer, present only when the status is `failed`.
   *
   * A sentence and not a code, for `HireChargeResult.failureMessage`'s reason: a
   * renter cannot act on the difference between a decline and a failed
   * authentication, and projecting the category would put a vocabulary on the
   * wire that nothing needs and everything would then have to keep.
   */
  readonly failureMessage?: string;
}

export interface CollectionSecurity {
  /**
   * Hold §8.7.2's excess against the renter's card, or say that nothing is held.
   *
   * **Idempotent per booking, and Booking relies on that rather than guarding
   * it** — `HirePayments.chargeForHire`'s rule and the same mechanism: the
   * attempt key is derived inside Payments from the booking and how many holds
   * have already failed, so working the collection window twice authorises once.
   * That is why this takes no key.
   */
  holdForCollection(
    request: CollectionSecurityRequest,
  ): Promise<CollectionSecurityResult>;
}
