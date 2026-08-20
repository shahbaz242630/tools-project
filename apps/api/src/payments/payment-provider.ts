import type { MoneyValue } from '@platform/core';

/**
 * Taking money from a person, in our words rather than a provider's
 * (BRD §5, §8.7, slice 5.2a; [ADR 0051](../../../../adr/0051-the-ledger-is-the-record-and-the-provider-is-a-channel.md)).
 *
 * **Written before any provider existed, deliberately.** The provider was chosen
 * on 20 August — Stripe — and this file was designed without its documentation
 * open, because ADR 0051's requirement is that the port speaks our verbs and the
 * surest way to fail that is to write it with one provider's object model in
 * front of you. `createPaymentIntent` is a Stripe noun; *"take the hire charge
 * for this booking, and tell me what the payer still has to do"* is ours.
 *
 * **The shape is asynchronous, and that is not a stylistic choice.** Strong
 * Customer Authentication applies to us: a UK card payment frequently requires
 * the payer to complete a challenge in their browser, so an attempt does not
 * finish when the call returns. §7's state table already knew this — `ACCEPTED →
 * AWAITING_PAYMENT → RESERVED | PAYMENT_FAILED` — and a port that returned only
 * "paid / not paid" would have no way to express the state the booking machine
 * spends most of its time in. Stripe, Mangopay and Adyen all have this shape;
 * modelling it is not modelling Stripe.
 */

/** Where an attempt has got to. A closed union, never a provider's own string. */
export const PAYMENT_ATTEMPT_STATUSES = [
  /** The payer must do something — typically a 3-D Secure challenge. */
  'pending_payer_action',
  /** Accepted and not yet final. The outcome arrives later, by webhook. */
  'processing',
  'succeeded',
  'failed',
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/**
 * What the payer still has to do, if anything.
 *
 * **The token is opaque to everything except the adapter that made it and the
 * provider's own browser library.** Nothing in the domain, the API contract or a
 * React component may read it, branch on it or store it — it is a bearer value
 * with a short life, and the moment something parses it we have a provider's
 * format in our code again.
 */
export interface PayerAction {
  /**
   * One kind today, and it is named rather than implied so that adding
   * `redirect` later is a compile error at every reader instead of a surprise.
   */
  readonly kind: 'confirm_in_browser';
  readonly token: string;
}

/** Why an attempt failed, in terms we can show a person. */
export interface PaymentFailure {
  /**
   * Our vocabulary, not the provider's. An adapter maps to it and collapses
   * anything it does not recognise to `declined` rather than inventing a value —
   * the same rule the queue metrics follow for an unknown job name.
   */
  readonly reason: 'declined' | 'authentication_failed' | 'provider_error';
  /**
   * A sentence for the payer. **No provider name, no code, no card details** —
   * this reaches a page.
   */
  readonly message: string;
}

/** One attempt at taking money, as it stands now. */
export interface PaymentAttempt {
  /**
   * The provider's identifier for this attempt.
   *
   * **A reference we store beside our own id, never a key.** ADR 0051: no
   * provider identifier is a primary key, a foreign key or a domain concept.
   */
  readonly providerReference: string;
  readonly status: PaymentAttemptStatus;
  /** Present only when `status` is `pending_payer_action`. */
  readonly payerAction?: PayerAction;
  /** Present only when `status` is `failed`. */
  readonly failure?: PaymentFailure;
}

/** What we are asking to be paid. */
export interface PaymentRequest {
  /**
   * Makes retrying this exact attempt safe.
   *
   * §8.7 requires idempotency keys on create, capture, refund and payout. **It
   * is per attempt, not per booking** — a renter whose card was declined is
   * entitled to try again, and reusing the first key would return the first
   * failure forever. The ledger's key is the per-booking one; these two are
   * different things and conflating them is how a retry becomes unpayable.
   */
  readonly idempotencyKey: string;
  readonly amount: MoneyValue;
  /**
   * A short description the payer may see on a statement.
   *
   * **Never personal data and never an address** (BRD §8.4.1) — an item's name
   * and nothing else.
   */
  readonly description: string;
}

/**
 * A payment provider.
 *
 * **Two methods, and neither mentions a card.** What instrument the money comes
 * from is the provider's business; ours is whether the hire is paid for.
 */
export interface PaymentProvider {
  /**
   * Which provider this is, for the reference we store and the line we log.
   *
   * A name rather than an inferred class, so a row written under one provider
   * stays readable after we have moved to another — the same reason
   * `webhook_events.provider` exists and named Stripe before Stripe arrived.
   */
  readonly name: string;

  /**
   * Start taking money. Returns as soon as the provider has an answer *or* a
   * challenge — not when the money has moved.
   */
  begin(request: PaymentRequest): Promise<PaymentAttempt>;

  /**
   * Where an attempt has got to now.
   *
   * **This is the reconciling read, and it exists because a webhook is not a
   * guarantee.** §8.7 requires daily reconciliation against the provider, and
   * BRD §4 forbids treating a webhook alone as the accounting record; both need
   * a way to ask.
   */
  read(providerReference: string): Promise<PaymentAttempt>;
}
