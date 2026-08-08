import { Time } from '@platform/core';
import type { AdminUserView } from '@platform/contracts';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import { auditableAccount } from './auditable-account.js';
import { ApprovalRefusedError } from './identity-errors.js';
import { refuseIfLastAdministrator } from './last-administrator.js';
import type { ProfileSummarySource } from './profile-summary-source.js';
import type { MirroredUser, UserDirectory } from './user-directory.js';

/**
 * Administering somebody else's account.
 *
 * **One of the four services `identity.service.ts` split into in slice H4.**
 * Everything here is an administrator acting on an account that is not theirs:
 * reading its state (BRD §8.13's read-only "view as user"), suspending it, and
 * lifting a suspension.
 *
 * **Every method takes an `Actor` and a reason, and that is the line between
 * this service and `AccountDataService`.** There, the caller is the subject and
 * owes nobody an explanation; here there is a second party, and §8.13 requires
 * the actor, the reason, the target and the before/after state — with the reason
 * shown to the person it was written about (ADR 0021, ADR 0024).
 *
 * Role changes are deliberately *not* here. They need two administrators rather
 * than one (ADR 0023), which is a different shape of operation and a different
 * service.
 */
export class AccountAdminService {
  constructor(
    private readonly users: UserDirectory,
    private readonly audit: AuditService,
    private readonly profileSummaries: ProfileSummarySource,
  ) {}

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

    await refuseIfLastAdministrator(this.users, target);

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
}
