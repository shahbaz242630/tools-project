import { Time } from '@platform/core';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PersonalDataEraser } from './personal-data-eraser.js';
import type { PersonalDataSource } from './personal-data-source.js';
import type { DataExport } from '@platform/contracts';
import { EXPORT_SCHEMA_VERSION } from '@platform/contracts';
import { UserConflictError } from './user-directory.js';
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

/**
 * The part of an account whose state is worth digesting.
 *
 * The email is included because a change to it is exactly what a later
 * `account.updated` entry would need to prove — and it is only ever hashed, so
 * the address itself does not reach the log. `clerkUserId` is left out: it is a
 * provider reference that says nothing about the account's own state.
 */
function auditableAccount(user: MirroredUser): unknown {
  return { id: user.id, email: user.email, role: user.role };
}

export class IdentityService {
  constructor(
    private readonly users: UserDirectory,
    private readonly ledger: WebhookLedger,
    private readonly audit: AuditService,
    private readonly eraser: PersonalDataEraser,
    private readonly profileSource: PersonalDataSource,
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
  async resolveSession(
    session: VerifiedSession,
    ipAddress: string | null = null,
  ): Promise<MirroredUser> {
    const { user, created } = await this.users.upsert({
      clerkUserId: session.clerkUserId,
      email: session.email,
    });

    if (created) {
      // The account is the actor in its own creation: nobody else caused it,
      // and attributing it to the system would lose the address it came from.
      await this.audit.record({
        actor: { userId: user.id, ipAddress },
        action: 'account.provisioned',
        targetType: 'user',
        targetId: user.id,
        after: auditableAccount(user),
      });
    }

    if (user.deletedAt !== null) throw new AccountDeletedError();

    // The token is Clerk-signed and therefore current; a stale mirror means a
    // `user.updated` was missed or is still in flight. Correcting it here means
    // an address change converges on the next request instead of waiting for a
    // redelivery that may never come.
    return this.correctEmail(user, session.email, { userId: user.id, ipAddress });
  }

  /**
   * Bring the mirrored address into line with the provider's, and record it.
   *
   * Shared by both correction paths — the webhook and the just-in-time one —
   * because they are the same operation arriving by different routes, and two
   * copies would drift the moment one of them gained a rule the other did not.
   *
   * **Survives a collision rather than failing the request.** `users.email` is
   * unique, so this can lose to a stale row: our mirror still holds an address
   * that somebody else has since taken at the provider. Rare, and recoverable
   * on its own — the other account's next request corrects *its* row and frees
   * the address. Throwing here would 500 an ordinary page load over a race that
   * resolves itself, so the stale address is kept and the caller carries on.
   */
  private async correctEmail(
    user: MirroredUser,
    email: string,
    actor: Actor | null,
  ): Promise<MirroredUser> {
    if (user.email === email) return user;

    let corrected: MirroredUser;
    try {
      corrected = await this.users.update(user.id, { email });
    } catch (error) {
      if (error instanceof UserConflictError) return user;
      throw error;
    }

    // Audited because changing the address on an account is how a takeover is
    // made permanent. The digests show that it changed without recording either
    // address (ADR 0017).
    await this.audit.record({
      actor,
      action: 'account.email_changed',
      targetType: 'user',
      targetId: user.id,
      before: auditableAccount(user),
      after: auditableAccount(corrected),
    });

    return corrected;
  }

  /**
   * Look up an account by our own identifier.
   *
   * The identity module's public answer to "does this account exist, and is it
   * still active" — the question every other module has about a user id it was
   * handed. Returns null for a soft-deleted account as well as an absent one:
   * to a caller deciding whether to show somebody's page, "gone" and "never
   * existed" are the same answer, and distinguishing them leaks that an account
   * once existed at that id.
   */
  async findActiveById(id: string): Promise<MirroredUser | null> {
    const user = await this.users.findById(id);
    return user === null || user.deletedAt !== null ? null : user;
  }

  /**
   * Assemble everything the platform holds about somebody.
   *
   * Identity assembles it because it owns the account, but it does not *hold*
   * most of it — each module supplies its own section through a port, for the
   * same reason erasure works that way. Reaching into `profiles` from here
   * would be the cross-module read the boundary exists to prevent, and this
   * module has no way to decrypt an address in any case.
   *
   * **Audited.** This is the one bulk disclosure the platform performs and the
   * only path by which a decrypted address leaves the database. An access log
   * with a hole exactly where the sensitive operation is would be worse than
   * none (ADR 0019). Recorded before the document is returned, so a disclosure
   * that happened cannot fail to be recorded.
   */
  async exportFor(actor: Actor): Promise<DataExport | null> {
    const user = await this.users.findById(actor.userId);
    if (user === null) return null;

    const [profile, activity] = await Promise.all([
      this.profileSource.exportFor(user.id),
      this.audit.listForActor(user.id),
    ]);

    const exportedAt = Time.toIsoUtc(Time.nowUtc());

    await this.audit.record({
      actor,
      action: 'account.exported',
      targetType: 'user',
      targetId: user.id,
      // No before or after: nothing changed. An export is a disclosure, not a
      // mutation, and inventing a state transition for it would make the two
      // indistinguishable in the trail.
    });

    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt,
      account: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: Time.toIsoUtc(user.createdAt),
        deletedAt: user.deletedAt === null ? null : Time.toIsoUtc(user.deletedAt),
        deletionRequestedAt:
          user.deletionRequestedAt === null
            ? null
            : Time.toIsoUtc(user.deletionRequestedAt),
      },
      profile,
      // The export itself is deliberately absent from the activity it contains
      // — it is recorded above, so it appears in the *next* export. Including
      // it would mean a document describing its own creation, which reads as a
      // bug to anyone comparing two exports.
      activity: activity.map((entry) => ({
        action: entry.action,
        targetType: entry.targetType,
        ipAddress: entry.ipAddress,
        createdAt: Time.toIsoUtc(entry.createdAt),
      })),
    };
  }

  /**
   * Act on a request to be deleted.
   *
   * **Order is the decision here** (ADR 0018). Personal data is erased first,
   * then the account is tombstoned. The reverse — tombstone, then erase — means
   * a failure between the two leaves somebody locked out of an account that
   * still holds their address, with no way to ask again. This way a failure
   * leaves the account usable and the request repeatable.
   *
   * Deleting the credential at Clerk happens afterwards, in the web app, which
   * is the only service holding a key that can (ADR 0015). Clerk's own
   * `user.deleted` webhook then arrives and applies against an already-deleted
   * row, which `apply` treats as a success.
   *
   * **Idempotent.** A second request is a success and records nothing new: the
   * state asked for is already the state.
   */
  async requestDeletion(actor: Actor): Promise<void> {
    const user = await this.users.findById(actor.userId);

    // Already gone, or never existed. Both are the requested state, and both
    // must answer success — a retry after a partial failure has to finish
    // rather than be told it is too late.
    if (user === null) return;
    if (user.deletedAt !== null) return;

    // Erase before tombstoning. Each module writes its own entry for what it
    // removed, so this produces the `profile.erased` line in the trail.
    await this.eraser.erase(actor);

    const at = Time.nowUtc();
    const deleted = await this.users.update(user.id, {
      deletedAt: at,
      deletionRequestedAt: at,
      email: tombstoneEmail(user.id),
    });

    // Recorded last, so the entry describes a completed deletion rather than an
    // attempted one. It is retained after the erasure it describes — that is
    // the point of §10.1, and it survives because it holds digests, not values.
    await this.audit.record({
      actor,
      action: 'account.deletion_requested',
      targetType: 'user',
      targetId: user.id,
      before: auditableAccount(user),
      after: auditableAccount(deleted),
    });
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
      const { user, created } = await this.users.upsert({
        clerkUserId: event.clerkUserId,
        email: event.email,
      });

      if (created) {
        // Actor is null: this arrived on a webhook, so nobody was holding a
        // session and there is no address to attribute it to. Recording it as
        // the account's own action would invent a sign-in that never happened.
        await this.audit.record({
          actor: null,
          action: 'account.provisioned',
          targetType: 'user',
          targetId: user.id,
          after: auditableAccount(user),
        });
      }

      // A deleted row stays deleted. Clerk cannot resurrect an account we have
      // tombstoned, and applying the new address would undo the erasure.
      if (user.deletedAt !== null) return;

      // Actor is null for the same reason provisioning's is: this arrived on a
      // webhook, so nobody was holding a session and there is no address to
      // attribute it to.
      await this.correctEmail(user, event.email, null);
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
