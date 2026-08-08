import type { Logger } from '@platform/observability';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import { AccountErasure } from './account-erasure.js';
import { auditableAccount } from './auditable-account.js';
import { AccountDeletedError } from './identity-errors.js';
import {} from './authentication-events.js';
import type {
  AuthenticationEventType,
  AuthenticationEvents,
  SessionActivity,
} from './authentication-events.js';
import { UserConflictError } from './user-directory.js';
import type { MirroredUser, UserDirectory } from './user-directory.js';
import type { VerifiedSession } from './session-verifier.js';
import type { WebhookLedger } from './webhook-ledger.js';

/**
 * The mirror: who somebody is, kept in step with the provider that owns it.
 *
 * **What is left of `identity.service.ts` after slice H4 split it four ways**,
 * and it kept the name and the `IDENTITY_SERVICE` token because this is what the
 * guard and the webhook route were always reaching for. The other three services
 * — `AccountDataService`, `AccountAdminService`, `RoleApprovalService` — took a
 * responsibility each.
 *
 * It holds the two rules that matter about a mirrored directory (ADR 0015): a
 * request must resolve to one of our rows even when the provider's webhook has
 * not arrived, and an event must change the mirror at most once however many
 * times it is delivered.
 *
 * **Deletion is the one thing here that is not the mirror's own**, and it is
 * reached through `AccountErasure` rather than performed here. Clerk's
 * `user.deleted` can arrive without our route having started it — its own
 * account screen is mounted for email changes — so the webhook path has to do
 * everything a deletion does. Slice 1.5c is where that was found out the hard
 * way; see `account-erasure.ts`.
 */

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
  | { readonly type: 'user.deleted'; readonly clerkUserId: string }
  | {
      /**
       * Something happened to a session — BRD §8.1's authentication events.
       *
       * One variant covering all four of Clerk's `session.*` events rather than
       * four, because the mirror does exactly the same thing with each: resolve
       * the account and append a row. What differs is the `event` field, which
       * is data rather than control flow.
       */
      readonly type: 'session.recorded';
      readonly clerkUserId: string;
      readonly clerkSessionId: string;
      readonly event: AuthenticationEventType;
      readonly occurredAt: Date;
      readonly activity: SessionActivity;
    };

export const CLERK_PROVIDER = 'clerk';

export class IdentityService {
  constructor(
    private readonly users: UserDirectory,
    private readonly ledger: WebhookLedger,
    private readonly audit: AuditService,
    private readonly authenticationEvents: AuthenticationEvents,
    /**
     * Shared with `AccountDataService`, which performs the same erasure when the
     * person asks for it through our own route (slice 1.5c, H4).
     */
    private readonly erasure: AccountErasure,

    /**
     * For the one thing this service does that has no other trace.
     *
     * A session event for an account we do not mirror is dropped, and a drop
     * with no log is a silent failure. Deliberately not defaulted to a no-op:
     * a default that quietly discards would make a test pass with the
     * mechanism disconnected, which is the failure mode this codebase has
     * hit often enough to write down.
     */
    private readonly logger: Logger,
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
        // The session is real and to hand — this path runs inside an
        // authenticated request — so provisioning names the sign-in it happened
        // in rather than passing null for convenience.
        actor: { userId: user.id, ipAddress, sessionId: session.sessionId },
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
    return this.correctEmail(user, session.email, {
      userId: user.id,
      ipAddress,
      sessionId: session.sessionId,
    });
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
   *
   * **A suspended account is not active either**, and that is how suspension
   * reaches the public profile without Profiles & Trust knowing the word: it
   * asks this question already, and the answer simply changed. A suspended
   * person stops being published to strangers, which is most of what suspension
   * means from outside (ADR 0024).
   */
  async findActiveById(id: string): Promise<MirroredUser | null> {
    const user = await this.users.findById(id);
    if (user === null) return null;
    return user.deletedAt !== null || user.suspendedAt !== null ? null : user;
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
    if (event.type === 'session.recorded') {
      await this.recordAuthenticationEvent(event);
      return;
    }

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
    // matters to a caller that may be retrying. This is also what makes the
    // ordinary case cheap — our own route erases first and then deletes the
    // credential, so the webhook that follows finds the work already done.
    if (user === null || user.deletedAt !== null) return;

    // Reaching here means the deletion started at Clerk rather than with us —
    // its account screen, or somebody removing the user from Clerk's dashboard.
    // The same work has to happen, and it did not until slice 1.5c.
    //
    // The actor is the account itself, with no address and no session. They did
    // ask for this; we simply did not serve the request and never saw the
    // client, so claiming either would be inventing evidence. Recording no actor
    // at all would be worse — a deletion is not something the system did on
    // nobody's behalf.
    await this.erasure.eraseAndTombstone(user, {
      userId: user.id,
      ipAddress: null,
      sessionId: null,
    });
  }

  /**
   * Store one authentication event against the account it belongs to.
   *
   * **A session event can arrive before the mirror row exists**, because Clerk
   * delivers `user.created` and `session.created` independently and neither is
   * ordered against the other. That is the whole reason just-in-time
   * provisioning exists (ADR 0015).
   *
   * When it happens the event is **dropped, with a warning**, and the three
   * alternatives are all worse:
   *
   * - *Throwing* looks right and is the worst of them. The delivery has already
   *   been claimed in the ledger by this point, so the retry is refused as a
   *   duplicate and the event is lost anyway — while leaving an unprocessed
   *   ledger row that nothing is watching (the stuck-webhook gap).
   * - *Provisioning from the session payload* would work — it carries the user
   *   object — but the field is nullable, so it fixes only some cases, and it
   *   adds a third path that can create an account. Two is already the number
   *   ADR 0015 had to justify.
   * - *Queueing it* needs a scheduler we do not have.
   *
   * The loss is bounded and small: it can only affect the very first session of
   * a brand-new account, in the milliseconds before that account's first
   * authenticated request provisions it — and that account's creation is
   * recorded as `account.provisioned` in the audit trail regardless, so the
   * activity page is not silent about the period.
   */
  private async recordAuthenticationEvent(event: {
    readonly clerkUserId: string;
    readonly clerkSessionId: string;
    readonly event: AuthenticationEventType;
    readonly occurredAt: Date;
    readonly activity: SessionActivity;
  }): Promise<void> {
    const user = await this.users.findByClerkUserId(event.clerkUserId);

    if (user === null) {
      this.logger.warn('dropped a session event for an unmirrored account', {
        clerkUserId: event.clerkUserId,
        event: event.event,
      });
      return;
    }

    // Recorded for a deleted account too, deliberately. A sign-in to an account
    // somebody asked us to delete is exactly the event a security enquiry wants
    // to see, and the row holds no personal data once erasure has nulled the
    // activity columns.
    await this.authenticationEvents.record({
      userId: user.id,
      clerkSessionId: event.clerkSessionId,
      event: event.event,
      occurredAt: event.occurredAt,
      activity: event.activity,
    });
  }
}
