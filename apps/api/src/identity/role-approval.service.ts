import { Time } from '@platform/core';
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
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import { auditableAccount } from './auditable-account.js';
import { ApprovalRefusedError } from './identity-errors.js';
import { refuseIfLastAdministrator } from './last-administrator.js';
import type { UserDirectory, UserRole } from './user-directory.js';

/**
 * Role changes, which take two administrators rather than one.
 *
 * **One of the four services `identity.service.ts` split into in slice H4**, and
 * the one with the clearest reason to be its own: everything here exists because
 * a single administrator must not be able to change a role alone (ADR 0023).
 * Granting a role is privilege escalation, and an administrator who can grant
 * themselves anything makes every other control in this module decorative.
 *
 * That is why it is not part of `AccountAdminService`, which suspends and
 * reinstates on one administrator's say-so. §9 wants suspension to be *fast* —
 * somebody is doing harm right now — and wants a role change to be *deliberate*.
 * Two services keeps the difference visible instead of leaving it to whichever
 * method somebody happens to read.
 */
export class RoleApprovalService {
  constructor(
    private readonly users: UserDirectory,
    private readonly audit: AuditService,
    private readonly approvals: AdminApprovalStore,
  ) {}

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

    await refuseIfLastAdministrator(this.users, target, role);

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
    await refuseIfLastAdministrator(this.users, target, proposal.action.role);

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
}
