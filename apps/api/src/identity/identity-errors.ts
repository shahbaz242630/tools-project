/**
 * Errors the identity module's services raise.
 *
 * **Their own module from slice H4**, when `identity.service.ts` split into four.
 * Both are thrown from more than one of the resulting services — a session that
 * resolves to a deleted account is the mirror's business, and a refused proposal
 * is raised by both suspension and role changes — so leaving them in any one
 * service would make the other three import from a sibling for a class with no
 * dependencies of its own.
 *
 * Nothing here imports anything. That is what keeps four services able to throw
 * the same error without any of them depending on another.
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
