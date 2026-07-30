/**
 * Recording provider webhook deliveries so each is applied exactly once.
 *
 * The guarantee is the database's, not this interface's. `record` is expected
 * to be implemented as an insert against a unique constraint: two API
 * containers handed the same retry concurrently both pass any "have I seen
 * this?" check written in application code, and only the constraint makes the
 * second one lose. An implementation that reads-then-writes satisfies the
 * signature and defeats the purpose.
 */

export interface WebhookDelivery {
  /** `clerk` today; Stripe joins it in Phase 5. */
  readonly provider: string;
  /** The provider's delivery id — `svix-id` for Clerk. Stable across retries. */
  readonly externalId: string;
  readonly eventType: string;
}

export interface WebhookLedger {
  /**
   * Claim a delivery for processing.
   *
   * Resolves `true` when this caller won and should apply the effect, `false`
   * when the delivery was already recorded and must be skipped.
   */
  claim(delivery: WebhookDelivery): Promise<boolean>;

  /**
   * Mark a claimed delivery as successfully applied.
   *
   * Deliberately separate from `claim`. A row claimed but never marked is a
   * delivery we accepted and failed to apply, which is exactly the state worth
   * alerting on — collapsing the two would erase the distinction between
   * "handled" and "started, then crashed".
   */
  markProcessed(
    delivery: Pick<WebhookDelivery, 'provider' | 'externalId'>,
  ): Promise<void>;
}
