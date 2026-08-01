import type { UserRole } from './user-directory.js';

/**
 * Administrative actions that need a second administrator to agree.
 *
 * BRD §8.13: "High-risk actions require step-up authentication and, for
 * selected actions, dual approval." This port is the "selected actions" half —
 * step-up authentication is already unconditional for the `ADMIN` role at the
 * guard (ADR 0021).
 *
 * The vocabulary is closed for the same reason `AuditAction` is: a new
 * approvable action should be a deliberate edit to a union somebody reviews,
 * not a string invented at a call site. It is deliberately *not* a Postgres
 * enum — that would put every future action behind a schema migration.
 */

/**
 * What is being proposed, and with what parameters.
 *
 * A discriminated union rather than a bag of nullable fields, so the parameters
 * of an action cannot be read as belonging to a different one. The store
 * persists it as JSON and parses it back through this type, which is the only
 * place the shape is trusted.
 *
 * One variant today. Account suspension is the obvious second, and adding it is
 * a variant here plus a branch in the executor — deliberately small, because
 * that is the test of whether this mechanism was worth building.
 */
export type ApprovableAction = {
  readonly kind: 'role.changed';
  /** The account whose role would change. */
  readonly userId: string;
  readonly role: UserRole;
};

/** How long a proposal stays approvable. */
export const APPROVAL_WINDOW_HOURS = 24;

/**
 * A proposal, as the rest of the application sees it.
 *
 * Timestamps rather than a state column, the same choice `users` makes for
 * deletion. A status enum would be a second thing to keep true, and the state
 * is entirely derivable — `state()` below is the one place that derives it.
 */
export interface AdminApproval {
  readonly id: string;
  readonly action: ApprovableAction;
  readonly targetType: string;
  readonly targetId: string;

  readonly proposedById: string;
  readonly proposedReason: string;
  readonly proposedAt: Date;
  readonly expiresAt: Date;

  readonly approvedById: string | null;
  readonly approvedReason: string | null;
  readonly approvedAt: Date | null;

  readonly cancelledById: string | null;
  readonly cancelledReason: string | null;
  readonly cancelledAt: Date | null;
}

export type ApprovalState = 'pending' | 'approved' | 'cancelled' | 'expired';

/**
 * Where a proposal stands, at a given moment.
 *
 * `now` is a parameter rather than read from the clock, because expiry is the
 * one property here that changes without anybody doing anything — and a
 * function that reads the clock cannot be tested for the boundary it exists to
 * enforce.
 *
 * Order matters. A cancelled or approved proposal keeps that outcome forever;
 * only a proposal that reached neither can expire. Checking expiry first would
 * make yesterday's approvals read as expired today, which would be a lie about
 * something that did happen.
 */
export function approvalState(approval: AdminApproval, now: Date): ApprovalState {
  if (approval.approvedAt !== null) return 'approved';
  if (approval.cancelledAt !== null) return 'cancelled';
  return approval.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}

export interface ProposeApproval {
  readonly action: ApprovableAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly proposedById: string;
  readonly proposedReason: string;
  readonly expiresAt: Date;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly byId: string;
  readonly reason: string;
  readonly at: Date;
}

/**
 * Raised when the database refuses a decision the service thought was valid.
 *
 * Concurrency, not a bug: two administrators can open the queue at the same
 * moment and both press approve. The row is claimed conditionally, so the
 * second one finds nothing to update and is told the proposal is already
 * decided rather than being allowed to apply the effect twice.
 */
export class ApprovalConflictError extends Error {
  constructor(message = 'the proposal is no longer pending') {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

export interface AdminApprovalStore {
  propose(input: ProposeApproval): Promise<AdminApproval>;

  find(id: string): Promise<AdminApproval | null>;

  /** Proposals nobody has decided yet and which have not expired, newest first. */
  listPending(now: Date, limit: number): Promise<readonly AdminApproval[]>;

  /**
   * Record the approval **and apply its effect, in one transaction.**
   *
   * One method rather than "mark approved" plus "do the thing", because the two
   * must not be separable. A decision recorded without its effect is a lie in a
   * record kept for audit; an effect applied without its decision is exactly
   * the unapproved administrative action this table exists to prevent. Inside a
   * transaction a failure to apply rolls the approval back, leaving the
   * proposal pending and the whole thing retryable.
   *
   * The claim is conditional on the row still being pending, so two concurrent
   * approvals cannot both succeed — the loser gets `ApprovalConflictError`.
   */
  approveAndApply(decision: ApprovalDecision): Promise<AdminApproval>;

  cancel(decision: ApprovalDecision): Promise<AdminApproval>;
}
