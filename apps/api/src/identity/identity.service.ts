import { Paging, Time } from '@platform/core';
import type { Logger } from '@platform/observability';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  APPROVAL_WINDOW_HOURS,
  ApprovalConflictError,
  approvalState,
} from './admin-approval.js';
import type {
  AdminApproval,
  AdminApprovalStore,
  ApprovableAction,
} from './admin-approval.js';
import type {
  AuthenticationEventType,
  AuthenticationEvents,
  RecordedAuthenticationEvent,
  SessionActivity,
} from './authentication-events.js';
import type { PersonalDataEraser } from './personal-data-eraser.js';
import type { PersonalDataSource } from './personal-data-source.js';
import type { ProfileSummarySource } from './profile-summary-source.js';
import type {
  AdminUserView,
  DataExport,
  ExportedListingsSection,
  ExportedProfile,
} from '@platform/contracts';
import { EXPORT_SCHEMA_VERSION } from '@platform/contracts';
import { UserConflictError } from './user-directory.js';
import type { MirroredUser, UserDirectory, UserRole } from './user-directory.js';
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
 * Raised when a proposal is refused on its own merits rather than the caller's.
 *
 * Distinct from `ApprovalConflictError`, which means somebody else got there
 * first. This one means the request itself does not make sense — the target
 * does not exist, or already holds that role, or the change would leave the
 * platform with no administrator at all.
 */
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRefusedError';
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

/**
 * How many sign-ins a data export carries.
 *
 * Higher than the activity page's fifty, because the two answer different
 * questions: a page is something you scan, an export is the copy you keep and
 * the one a subject-access request is answered with. Bounded all the same —
 * nothing prunes `authentication_events`, so an account signing in daily for
 * five years would otherwise assemble two thousand rows into a synchronous
 * response, and the export is already the most expensive endpoint we serve.
 *
 * The cut is recorded in the document rather than left silent, so nobody reads
 * a truncated file as a complete one.
 */
export const EXPORTED_SIGN_IN_LIMIT = 500;

/** How many sign-ins the page shows. Matches the activity trail's fifty. */
export const DEFAULT_SIGN_IN_LIMIT = 50;

/**
 * The largest page anyone may ask for.
 *
 * An engineering bound on one query's cost, mirroring `MAX_ACTIVITY_LIMIT`.
 * There is no pagination yet and nothing prunes this table, so an unbounded
 * caller would read a whole sign-in history into memory to render fifty rows.
 */
export const MAX_SIGN_IN_LIMIT = 200;

/**
 * Clamp a caller-supplied limit into range, rejecting nonsense quietly.
 *
 * Delegates to the shared clamp from slice H2. This copy was the guarded one —
 * the audit module's was not — and consolidating kept this behaviour rather than
 * the other.
 */
export function boundedSignInLimit(limit: number): number {
  return Paging.boundedLimit(limit, {
    fallback: DEFAULT_SIGN_IN_LIMIT,
    max: MAX_SIGN_IN_LIMIT,
  });
}

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
  return {
    id: user.id,
    email: user.email,
    role: user.role,

    /**
     * Whether the account is suspended — a boolean, not the timestamp.
     *
     * It has to be here or a suspension would digest identically before and
     * after, and the entry would claim nothing changed about the one thing that
     * did. A boolean rather than `suspendedAt` for the reason `updatedAt` is
     * excluded entirely: the state is what a reader compares, and a timestamp
     * would make a re-suspension with identical circumstances look like a
     * different change.
     */
    suspended: user.suspendedAt !== null,
  };
}

export class IdentityService {
  constructor(
    private readonly users: UserDirectory,
    private readonly ledger: WebhookLedger,
    private readonly audit: AuditService,
    private readonly eraser: PersonalDataEraser,
    private readonly profileSource: PersonalDataSource<ExportedProfile>,
    /**
     * Catalogue's section — the listings this person wrote, and the collection
     * addresses on them (slice 2.5a).
     *
     * A **second** source rather than a wider first one, because each module
     * supplies what it holds and knows how to make readable. Its erasure travels
     * through the same `eraser` port as profiles, composed at the composition
     * root; there is no second eraser argument here, which is the port doing its
     * job.
     */
    private readonly listingSource: PersonalDataSource<ExportedListingsSection>,
    private readonly profileSummaries: ProfileSummarySource,
    private readonly approvals: AdminApprovalStore,
    private readonly authenticationEvents: AuthenticationEvents,

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

    const [profile, activity, signIns, listings] = await Promise.all([
      this.profileSource.exportFor(user.id),
      this.audit.listForActor(user.id),
      // One more than we will serve, so "there were more" is measured rather
      // than inferred from the page being full — a count that equals the limit
      // exactly is otherwise indistinguishable from a truncated one.
      this.authenticationEvents.listFor(user.id, Paging.probe(EXPORTED_SIGN_IN_LIMIT)),
      this.listingSource.exportFor(user.id),
    ]);

    // The same probe-and-fit the listings section performs for itself, now
    // through the shared helper rather than open-coded here (slice H2).
    const signInPage = Paging.fitTo(signIns, EXPORTED_SIGN_IN_LIMIT);
    const signInsTruncated = signInPage.truncated;
    const includedSignIns = signInPage.items;

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

      // A separate section rather than folded into `activity`, because they are
      // different kinds of record and flattening them would lose that. An
      // activity entry is something somebody chose to do; a sign-in is
      // something that happened to the account, and it carries a device and a
      // place that no activity entry has.
      //
      // The Clerk session id is included on purpose: it is what lets somebody
      // match a line here against a device in Clerk's own list, and Article 15
      // is about the data we hold — which includes the reference we hold.
      // Stated in the file, because a truncated export that does not say so is
      // one somebody reads as the whole record. Only ever true for an account
      // with more than five hundred sign-ins.
      signInsTruncated,
      signIns: includedSignIns.map((entry) => ({
        event: entry.event,
        sessionId: entry.clerkSessionId,
        occurredAt: Time.toIsoUtc(entry.occurredAt),
        ipAddress: entry.activity.ipAddress,
        browserName: entry.activity.browserName,
        browserVersion: entry.activity.browserVersion,
        deviceType: entry.activity.deviceType,
        isMobile: entry.activity.isMobile,
      })),

      // Catalogue's section (slice 2.5a). Supplied by that module rather than
      // read from here, for the same reason as the profile: it is the module
      // holding the key, and this one has no way to decrypt an address.
      //
      // **This is the third bulk disclosure in the document**, after the
      // decrypted profile address and the sign-in history, and it is one more
      // reason the whole endpoint is audited (ADR 0019). Somebody with several
      // listings has several addresses in this file.
      //
      // **The section arrives with its own truncation flag** rather than as a
      // bare array (slice H2). Catalogue applied the bound, so Catalogue is the
      // only thing that knows whether it bit — inferring it here from a length
      // would be the guess `Paging.probe` exists to remove.
      listings: listings.listings,
      listingsTruncated: listings.truncated,
    };
  }

  /**
   * The caller's own sign-in history.
   *
   * **Not audited, and that is the deliberate difference from `exportFor`.**
   * Reading your own security history is not a disclosure — nothing leaves the
   * platform, and the reader is the subject. Recording it would put a row in
   * the trail every time somebody checked the trail, which grows without bound
   * and buries the entries that matter. The export is audited because it hands
   * over a file; this renders a page.
   *
   * No id parameter, the same reasoning as `/me/profile`: the actor comes from
   * the verified session, so there is no way to address anybody else's.
   */
  async signInsFor(
    userId: string,
    limit: number = DEFAULT_SIGN_IN_LIMIT,
  ): Promise<readonly RecordedAuthenticationEvent[]> {
    return this.authenticationEvents.listFor(userId, boundedSignInLimit(limit));
  }

  /**
   * What an administrator may see of somebody's account.
   *
   * BRD §8.13's read-only "view as user", built as a **projection rather than a
   * session**: the administrator's own session stays theirs, nothing here mints
   * a token as another person, and there is no shape in this method that could
   * change anything. Write-capable impersonation is prohibited at launch, and
   * the cheapest way to honour that is to have no mechanism for it (ADR 0022).
   *
   * **Audited before the read**, with the reason, the same ordering as the
   * export and the activity disclosure: a disclosure that happened cannot fail
   * to be recorded. The entry names the account as target, so it reaches that
   * person's own activity page (ADR 0021's correction).
   *
   * Uses `findById` rather than `findActiveById` deliberately. A deleted
   * account is exactly what support is asked about after a deletion, and the
   * timestamps are the answer; the public route's refusal to distinguish
   * "deleted" from "never existed" is an anti-enumeration measure, and the
   * caller here is a named administrator in an audit trail.
   */
  async adminViewFor(
    actor: Actor,
    userId: string,
    reason: string,
  ): Promise<AdminUserView | null> {
    await this.audit.record({
      actor,
      action: 'admin.user_viewed',
      targetType: 'user',
      targetId: userId,
      reason,
      // No before or after: nothing changed. Inventing a state transition for a
      // read would make disclosures and modifications indistinguishable in a
      // trail retained for six years.
    });

    const user = await this.users.findById(userId);
    if (user === null) return null;

    return {
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
        suspendedAt: user.suspendedAt === null ? null : Time.toIsoUtc(user.suspendedAt),
        suspensionReason: user.suspensionReason,
      },
      profile: await this.profileSummaries.summaryFor(user.id),
    };
  }

  /**
   * Suspend an account.
   *
   * **One administrator, deliberately** — not the dual approval a role change
   * needs (ADR 0024). Suspension is protective and urgent and completely
   * reversible; a control that cannot act quickly is not a safety control. The
   * accountability is the reason, the audit entry, and the fact that the person
   * it happened to reads both.
   *
   * Records **before and after state**, which is the first time an admin action
   * here has any: §8.13 has asked for it since slice 1.8a, and every admin
   * action until now was a read.
   */
  async suspend(actor: Actor, userId: string, reason: string): Promise<MirroredUser> {
    const target = await this.requireSuspendable(actor, userId);

    if (target.suspendedAt !== null) {
      throw new ApprovalRefusedError('that account is already suspended');
    }

    await this.refuseIfLastUsableAdministrator(target);

    const suspended = await this.users.setSuspension(target.id, {
      at: Time.nowUtc(),
      byId: actor.userId,
      reason,
    });

    await this.audit.record({
      actor,
      action: 'account.suspended',
      targetType: 'user',
      targetId: target.id,
      reason,
      before: auditableAccount(target),
      after: auditableAccount(suspended),
    });

    return suspended;
  }

  /**
   * Lift a suspension.
   *
   * Also one administrator, and for a sharper reason than suspending is:
   * correcting a wrong suspension must not be the slow path. The reason is
   * mandatory here too — "why is this person back" is exactly as worth
   * recording as why they were stopped.
   */
  async reinstate(actor: Actor, userId: string, reason: string): Promise<MirroredUser> {
    const target = await this.requireSuspendable(actor, userId, { self: 'allowed' });

    if (target.suspendedAt === null) {
      throw new ApprovalRefusedError('that account is not suspended');
    }

    const reinstated = await this.users.setSuspension(target.id, null);

    await this.audit.record({
      actor,
      action: 'account.reinstated',
      targetType: 'user',
      targetId: target.id,
      reason,
      before: auditableAccount(target),
      after: auditableAccount(reinstated),
    });

    return reinstated;
  }

  /**
   * The checks both directions share.
   *
   * Suspending yourself is refused because a suspended administrator loses the
   * admin surface (ADR 0024) and so could not undo it — a one-way door with no
   * handle on the far side. **Reinstating yourself is a different question**
   * and is not reachable anyway: a suspended administrator cannot call this
   * route at all. Allowing it in the service keeps the refusal in one place —
   * the guard — rather than two that could disagree.
   */
  private async requireSuspendable(
    actor: Actor,
    userId: string,
    options: { self?: 'allowed' } = {},
  ): Promise<MirroredUser> {
    if (options.self !== 'allowed' && userId === actor.userId) {
      throw new ApprovalRefusedError(
        'you cannot suspend yourself — you would not be able to undo it',
      );
    }

    const target = await this.users.findById(userId);
    if (target === null) throw new ApprovalRefusedError('no such account');
    if (target.deletedAt !== null) {
      throw new ApprovalRefusedError('that account has been deleted');
    }

    return target;
  }

  /**
   * Refuse a suspension that would leave nobody able to administer anything.
   *
   * The same lockout ADR 0023 guards against on demotion, reached the other
   * way: suspending the last usable administrator leaves zero, and role
   * assignment needs two administrators to work at all. Recovery would be a
   * database write on a production box.
   *
   * **Unreachable through the admin route today, and kept anyway.** Over HTTP
   * the caller must themselves be a usable administrator — the guard refuses a
   * suspended or deleted one — so at this point the count is always at least
   * two, them and the target. The rule exists for the caller that does not
   * exist yet: BRD §5.1 gives suspension to Trust & Safety, and an automated
   * risk check has no session behind it and no such guarantee. The test for it
   * calls this service directly and says so, because driving it over HTTP would
   * pass on a different refusal entirely.
   */
  private async refuseIfLastUsableAdministrator(target: MirroredUser): Promise<void> {
    if (target.role !== 'ADMIN') return;

    const administrators = await this.users.countAdministrators();
    if (administrators <= 1) {
      throw new ApprovalRefusedError(
        'that is the last administrator — promote somebody else first',
      );
    }
  }

  /**
   * Propose a role change for a second administrator to agree to.
   *
   * BRD §8.13 asks for dual approval on selected actions. Changing a role is
   * the first, and the one where a single administrator acting alone is worst:
   * it is privilege escalation, and an administrator who can grant themselves
   * anything makes every other control here decorative (ADR 0023).
   *
   * The proposal is checked now *and* the effect is checked again at approval,
   * because a day may pass between them.
   */
  async proposeRoleChange(
    actor: Actor,
    userId: string,
    role: UserRole,
    reason: string,
  ): Promise<AdminApproval> {
    const target = await this.users.findById(userId);

    // Not `findActiveById`: the wording matters, and a deleted account is not
    // something to change the role of. Refused rather than 404 so the
    // administrator is told which of the two it is.
    if (target === null) throw new ApprovalRefusedError('no such account');
    if (target.deletedAt !== null) {
      throw new ApprovalRefusedError('that account has been deleted');
    }
    if (target.role === role) {
      throw new ApprovalRefusedError(`that account is already ${role}`);
    }

    await this.refuseIfLastAdministrator(target, role);

    const action: ApprovableAction = { kind: 'role.changed', userId, role };
    const proposal = await this.approvals.propose({
      action,
      targetType: 'user',
      targetId: userId,
      proposedById: actor.userId,
      proposedReason: reason,
      // Elapsed hours, not calendar days — a deadline must not move because the
      // clocks did. `Time.addHours` exists for exactly this distinction.
      expiresAt: Time.addHours(Time.nowUtc(), APPROVAL_WINDOW_HOURS),
    });

    // Recorded against the *target*, so the person whose role somebody proposed
    // changing sees it on their own activity page — the same reasoning that
    // makes an administrative read visible to its subject (ADR 0021).
    await this.audit.record({
      actor,
      action: 'admin.approval_proposed',
      targetType: 'user',
      targetId: userId,
      reason,
    });

    return proposal;
  }

  /** Proposals still waiting for a second administrator. */
  listPendingApprovals(limit = 50): Promise<readonly AdminApproval[]> {
    return this.approvals.listPending(Time.nowUtc(), limit);
  }

  /**
   * Agree to somebody else's proposal, and carry it out.
   *
   * **The approver is never the proposer.** Checked here, checked again in the
   * store's conditional claim, and refused by a database CHECK constraint under
   * both. Three layers for one rule is not belt and braces for its own sake:
   * this is the rule the entire mechanism exists to enforce, and the cost of it
   * failing is one administrator granting themselves whatever they like.
   */
  async approve(
    actor: Actor,
    approvalId: string,
    reason: string,
  ): Promise<AdminApproval> {
    const proposal = await this.requirePending(approvalId);

    if (proposal.proposedById === actor.userId) {
      throw new ApprovalRefusedError(
        'you proposed this, so somebody else has to approve it',
      );
    }

    // Re-checked at approval, not only at proposal. A day is a long time: the
    // other administrator may have been demoted in between, and approving now
    // could leave nobody able to administer anything.
    const target = await this.users.findById(proposal.action.userId);
    if (target === null || target.deletedAt !== null) {
      throw new ApprovalRefusedError('that account no longer exists');
    }
    await this.refuseIfLastAdministrator(target, proposal.action.role);

    const approved = await this.approvals.approveAndApply({
      approvalId,
      byId: actor.userId,
      reason,
      at: Time.nowUtc(),
    });

    await this.audit.record({
      actor,
      action: 'admin.approval_granted',
      targetType: 'user',
      targetId: proposal.action.userId,
      reason,
      before: auditableAccount(target),
      after: auditableAccount({ ...target, role: proposal.action.role }),
    });

    return approved;
  }

  /**
   * Withdraw a proposal.
   *
   * Anyone with the role may cancel, **including the proposer**. Withdrawing
   * your own request is not what dual approval guards against — the rule is
   * about causing an effect, and cancelling causes none.
   */
  async cancelApproval(
    actor: Actor,
    approvalId: string,
    reason: string,
  ): Promise<AdminApproval> {
    const proposal = await this.requirePending(approvalId);

    const cancelled = await this.approvals.cancel({
      approvalId,
      byId: actor.userId,
      reason,
      at: Time.nowUtc(),
    });

    await this.audit.record({
      actor,
      action: 'admin.approval_cancelled',
      targetType: 'user',
      targetId: proposal.action.userId,
      reason,
    });

    return cancelled;
  }

  private async requirePending(approvalId: string): Promise<AdminApproval> {
    const proposal = await this.approvals.find(approvalId);
    if (proposal === null) throw new ApprovalRefusedError('no such proposal');

    const state = approvalState(proposal, Time.nowUtc());
    if (state !== 'pending') {
      // A conflict rather than a refusal: the request was well formed and would
      // have been fine a moment earlier. The distinction reaches the caller as
      // 409 rather than 400.
      throw new ApprovalConflictError(`that proposal is already ${state}`);
    }

    return proposal;
  }

  /**
   * Refuse a change that would leave nobody able to administer anything.
   *
   * The lockout ADR 0021 warned about, in its most permanent form: demote the
   * last administrator and there is no one left to promote anybody, and no
   * route that could — role assignment is *this* mechanism, which needs two
   * administrators to work at all. Recovery would be a database write on a
   * production box.
   *
   * Only demotions can trigger it, and only when the target is currently the
   * administrator being counted.
   */
  private async refuseIfLastAdministrator(
    target: MirroredUser,
    role: UserRole,
  ): Promise<void> {
    if (role === 'ADMIN' || target.role !== 'ADMIN') return;

    const administrators = await this.users.countAdministrators();
    if (administrators <= 1) {
      throw new ApprovalRefusedError(
        'that is the last administrator — promote somebody else first',
      );
    }
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
   *
   * The work itself is in `eraseAndTombstone`, shared with the webhook path —
   * see there for why that sharing is not optional.
   */
  async requestDeletion(actor: Actor): Promise<void> {
    const user = await this.users.findById(actor.userId);

    // Already gone, or never existed. Both are the requested state, and both
    // must answer success — a retry after a partial failure has to finish
    // rather than be told it is too late.
    if (user === null) return;
    if (user.deletedAt !== null) return;

    await this.eraseAndTombstone(user, actor);
  }

  /**
   * Everything a deletion does, in the order ADR 0018 requires.
   *
   * **Shared between the two paths that can start one, and that sharing is the
   * whole point of this method existing.** Until slice 1.5c the webhook branch
   * had its own two-line version that tombstoned the email and stopped: no
   * erasure, no redaction, no `deletionRequestedAt`, no audit entry. It was
   * written on the assumption that `user.deleted` only ever *follows* our own
   * route, and Clerk's account screen — mounted for email changes in 1.7 —
   * makes that false. Somebody deleting through it was told their data was
   * gone while the profile, the address ciphertext and the sign-in history all
   * survived.
   *
   * That is exactly the failure slice 1.7 fixed for `account.email_changed`,
   * where two copies of a rule drifted on the one thing missing from both. The
   * answer is the same: one method, two callers, no second copy to forget.
   *
   * **Erase before tombstoning.** The reverse leaves somebody locked out of an
   * account that still holds their address, with no way to authenticate and ask
   * again. This way a failure leaves the account usable and the request
   * repeatable — which matters more on the webhook path, where nobody is
   * watching a page for an error.
   */
  private async eraseAndTombstone(user: MirroredUser, actor: Actor): Promise<void> {
    // Each module writes its own entry for what it removed, so this produces
    // the `profile.erased` line in the trail.
    await this.eraser.erase(actor);

    // Identity's own personal data, erased directly rather than through the
    // eraser port — that port is how *other* modules contribute, and this
    // module reaching for it to erase its own table would be indirection with
    // no boundary behind it.
    //
    // Redaction, not deletion: the rows stay and lose their activity columns.
    // §10.1 retains security logs six years, and "a session started at 14:02"
    // is what can honestly be retained once the device and address are gone.
    await this.authenticationEvents.eraseActivity(user.id);

    const at = Time.nowUtc();
    const deleted = await this.users.update(user.id, {
      deletedAt: at,

      // Set on both paths. It answers "when did they ask", which is the
      // question a data-protection enquiry actually puts — and a deletion that
      // started at Clerk was still asked for, just not here.
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
    await this.eraseAndTombstone(user, {
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
