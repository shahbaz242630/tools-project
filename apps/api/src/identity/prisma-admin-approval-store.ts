import type { PrismaClient } from '@platform/database';
import {
  ApprovalConflictError,
  type AdminApproval,
  type AdminApprovalStore,
  type ApprovableAction,
  type ApprovalDecision,
  type ProposeApproval,
} from './admin-approval.js';
import type { UserRole } from './user-directory.js';

/**
 * Postgres-backed dual approval.
 *
 * Two things live here that could not live above it. The **transaction** that
 * makes an approval and its effect inseparable, and the **conditional claim**
 * that makes two simultaneous approvals resolve to one.
 *
 * The database also enforces the rule this whole mechanism is for — an approver
 * can never be the proposer — as a CHECK constraint. That is deliberately
 * belt and braces with the service check above: this class could be rewritten
 * carelessly and Postgres would still refuse.
 */

interface ApprovalRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  proposedById: string;
  proposedReason: string;
  proposedAt: Date;
  expiresAt: Date;
  approvedById: string | null;
  approvedReason: string | null;
  approvedAt: Date | null;
  cancelledById: string | null;
  cancelledReason: string | null;
  cancelledAt: Date | null;
}

/**
 * Rebuild the action from what was stored.
 *
 * The one place a JSON column is trusted, and it is narrowed rather than cast.
 * A row whose payload does not match its action is corrupt in a way no caller
 * could sensibly handle, so it throws here rather than being handed onward as
 * a plausible-looking object.
 */
function toAction(action: string, payload: unknown): ApprovableAction {
  if (action !== 'role.changed') {
    throw new Error(`unknown approvable action: ${action}`);
  }

  const record = payload as { userId?: unknown; role?: unknown };
  const { userId, role } = record;

  if (typeof userId !== 'string' || (role !== 'ADMIN' && role !== 'USER')) {
    throw new Error(`malformed payload for ${action}`);
  }

  return { kind: 'role.changed', userId, role: role satisfies UserRole };
}

function toApproval(row: ApprovalRow): AdminApproval {
  return {
    id: row.id,
    action: toAction(row.action, row.payload),
    targetType: row.targetType,
    targetId: row.targetId,
    proposedById: row.proposedById,
    proposedReason: row.proposedReason,
    proposedAt: row.proposedAt,
    expiresAt: row.expiresAt,
    approvedById: row.approvedById,
    approvedReason: row.approvedReason,
    approvedAt: row.approvedAt,
    cancelledById: row.cancelledById,
    cancelledReason: row.cancelledReason,
    cancelledAt: row.cancelledAt,
  };
}

/** The parameters of an action, as JSON. The discriminant is stored separately. */
function toPayload(action: ApprovableAction): Record<string, string> {
  return { userId: action.userId, role: action.role };
}

export class PrismaAdminApprovalStore implements AdminApprovalStore {
  constructor(private readonly prisma: PrismaClient) {}

  async propose(input: ProposeApproval): Promise<AdminApproval> {
    const row = await this.prisma.adminApproval.create({
      data: {
        action: input.action.kind,
        targetType: input.targetType,
        targetId: input.targetId,
        payload: toPayload(input.action),
        proposedById: input.proposedById,
        proposedReason: input.proposedReason,
        expiresAt: input.expiresAt,
      },
    });

    return toApproval(row);
  }

  async find(id: string): Promise<AdminApproval | null> {
    const row = await this.prisma.adminApproval.findUnique({ where: { id } });
    return row === null ? null : toApproval(row);
  }

  async listPending(now: Date, limit: number): Promise<readonly AdminApproval[]> {
    const rows = await this.prisma.adminApproval.findMany({
      where: {
        approvedAt: null,
        cancelledAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { proposedAt: 'desc' },
      take: limit,
    });

    return rows.map(toApproval);
  }

  async approveAndApply(decision: ApprovalDecision): Promise<AdminApproval> {
    return this.prisma.$transaction(async (tx) => {
      // Claimed conditionally, and this is the concurrency control. Two
      // administrators pressing approve at the same moment both pass the
      // service's checks against the same pending row; `updateMany` with the
      // pending predicate means exactly one of them changes a row, and the
      // other sees a count of zero and is told so.
      //
      // `proposedById: { not: decision.byId }` is here as well as in the CHECK
      // constraint. The constraint is the guarantee; this makes the refusal a
      // clean conflict rather than a database error surfacing as a 500.
      const claimed = await tx.adminApproval.updateMany({
        where: {
          id: decision.approvalId,
          approvedAt: null,
          cancelledAt: null,
          expiresAt: { gt: decision.at },
          proposedById: { not: decision.byId },
        },
        data: {
          approvedById: decision.byId,
          approvedReason: decision.reason,
          approvedAt: decision.at,
        },
      });

      if (claimed.count === 0) throw new ApprovalConflictError();

      const row = await tx.adminApproval.findUniqueOrThrow({
        where: { id: decision.approvalId },
      });
      const approval = toApproval(row);

      // The effect, inside the same transaction as the decision that authorised
      // it. A failure here — the target account was deleted between proposal
      // and approval, say — rolls the approval back and leaves the proposal
      // pending, which is both honest and retryable.
      await this.apply(tx, approval.action);

      return approval;
    });
  }

  async cancel(decision: ApprovalDecision): Promise<AdminApproval> {
    // No expiry predicate: cancelling an expired proposal is harmless and
    // recording that somebody withdrew it is better than silently refusing.
    // Anyone may cancel, including the proposer — withdrawing your own request
    // is not the thing dual approval guards against.
    const claimed = await this.prisma.adminApproval.updateMany({
      where: { id: decision.approvalId, approvedAt: null, cancelledAt: null },
      data: {
        cancelledById: decision.byId,
        cancelledReason: decision.reason,
        cancelledAt: decision.at,
      },
    });

    if (claimed.count === 0) throw new ApprovalConflictError();

    const row = await this.prisma.adminApproval.findUniqueOrThrow({
      where: { id: decision.approvalId },
    });
    return toApproval(row);
  }

  /**
   * Carry out an approved action.
   *
   * A switch over the closed union, so a new variant is a compile error here
   * rather than a proposal that can be approved and then quietly does nothing.
   */
  private async apply(
    tx: Pick<PrismaClient, 'user'>,
    action: ApprovableAction,
  ): Promise<void> {
    await tx.user.update({
      where: { id: action.userId },
      data: { role: action.role },
    });
  }
}
