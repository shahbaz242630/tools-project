import { Time } from '@platform/core';
import type { MirroredUser, UserDirectory } from './user-directory.js';
import type { VerifiedSession } from './session-verifier.js';
import type { WebhookLedger } from './webhook-ledger.js';

/**
 * The identity module's application service.
 *
 * Holds the two rules that matter about a mirrored directory: a request must
 * resolve to one of our rows even when the provider's webhook has not arrived,
 * and an event must change the mirror at most once however many times it is
 * delivered.
 */

/** Raised when a session belongs to an account we have marked deleted. */
export class AccountDeletedError extends Error {
  constructor() {
    super('account has been deleted');
    this.name = 'AccountDeletedError';
  }
}

/**
 * A change to mirror, in our vocabulary rather than Clerk's.
 *
 * `created` and `updated` collapse into one case on purpose. They differ only
 * in what the provider believed about its own state, and treating them
 * separately invites an ordering bug: webhooks are not ordered, so an `updated`
 * can arrive before the `created` it follows.
 */
export type IdentityEvent =
  | {
      readonly type: 'user.upserted';
      readonly clerkUserId: string;
      readonly email: string;
    }
  | { readonly type: 'user.deleted'; readonly clerkUserId: string };

export const CLERK_PROVIDER = 'clerk';

/**
 * The address a deleted account's row keeps.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real domain, and our
 * own row id makes it unique without a lookup. Replacing the address frees the
 * real one for genuine re-registration — a retained unique row would otherwise
 * lock that person out of the platform permanently — and drops personal data
 * we no longer have a purpose for.
 */
export function tombstoneEmail(userId: string): string {
  return `deleted+${userId}@deleted.invalid`;
}

export class IdentityService {
  constructor(
    private readonly users: UserDirectory,
    private readonly ledger: WebhookLedger,
  ) {}

  /**
   * Resolve a verified session to our user row, creating it if absent.
   *
   * Provisioning here rather than only in the webhook is what makes the sign-up
   * flow work: Clerk delivers `user.created` asynchronously, so a person who
   * signs up and is redirected straight into the application would otherwise
   * meet an error until the delivery landed. The webhook still runs and is
   * still what applies later changes — this is the belt to its braces, and both
   * converge on the same row because `clerkUserId` is unique.
   */
  async resolveSession(session: VerifiedSession): Promise<MirroredUser> {
    const user = await this.users.upsert({
      clerkUserId: session.clerkUserId,
      email: session.email,
    });

    if (user.deletedAt !== null) throw new AccountDeletedError();

    // The token is Clerk-signed and therefore current; a stale mirror means a
    // `user.updated` was missed or is still in flight. Correcting it here means
    // an address change converges on the next request instead of waiting for a
    // redelivery that may never come.
    if (user.email !== session.email) {
      return this.users.update(user.id, { email: session.email });
    }

    return user;
  }

  /**
   * Apply a provider event to the mirror, exactly once.
   *
   * Returns `false` when the delivery was already recorded, so the caller can
   * answer the provider with a success it will not retry. A duplicate is a
   * normal event, not an error — providers retry on timeouts they caused.
   */
  async applyEvent(externalId: string, event: IdentityEvent): Promise<boolean> {
    const claimed = await this.ledger.claim({
      provider: CLERK_PROVIDER,
      externalId,
      eventType: event.type,
    });

    if (!claimed) return false;

    // Deliberately after the claim. Claiming first means a delivery that
    // crashes mid-apply is not retried into a second partial application; the
    // unprocessed row left behind is the signal that it needs attention. The
    // alternative — apply then record — double-applies on any crash between the
    // two, and for a mirror that is the worse failure.
    await this.apply(event);

    await this.ledger.markProcessed({
      provider: CLERK_PROVIDER,
      externalId,
    });

    return true;
  }

  private async apply(event: IdentityEvent): Promise<void> {
    if (event.type === 'user.upserted') {
      const user = await this.users.upsert({
        clerkUserId: event.clerkUserId,
        email: event.email,
      });

      // A deleted row stays deleted. Clerk cannot resurrect an account we have
      // tombstoned, and applying the new address would undo the erasure.
      if (user.deletedAt !== null) return;

      if (user.email !== event.email) {
        await this.users.update(user.id, { email: event.email });
      }
      return;
    }

    const user = await this.users.findByClerkUserId(event.clerkUserId);

    // Nothing to delete, or already deleted. Both are successes: the mirror
    // already reflects the requested state, which is the only thing that
    // matters to a caller that may be retrying.
    if (user === null || user.deletedAt !== null) return;

    await this.users.update(user.id, {
      deletedAt: Time.nowUtc(),
      email: tombstoneEmail(user.id),
    });
  }
}
