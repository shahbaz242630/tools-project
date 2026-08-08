import { ApprovalRefusedError } from './identity-errors.js';
import type { MirroredUser, UserDirectory, UserRole } from './user-directory.js';

/**
 * The rule that stops the platform being left with nobody who can administer it.
 *
 * **Extracted in slice H4, and the split is what made it worth extracting.**
 * `identity.service.ts` held two private methods for this —
 * `refuseIfLastUsableAdministrator` for suspension and `refuseIfLastAdministrator`
 * for role changes — with the same count, the same threshold and the same
 * message. They differed in one line. Splitting the file along its
 * responsibilities would have put them in two different services, at which point
 * they stop being one rule that happens to be written twice and become two rules
 * that can drift.
 *
 * **What "usable" means is the directory's decision, not this function's.**
 * `countAdministrators` counts only administrators who are neither deleted nor
 * suspended, because an account that cannot sign in cannot administer anything —
 * so counting one would let the last person who *can* act be removed on the
 * strength of somebody who cannot.
 */
export interface LastAdministratorGuard {
  readonly users: UserDirectory;
}

/**
 * Refuse an action that would remove the last usable administrator.
 *
 * `becomingRole` is what distinguishes the two callers, and it is the whole
 * difference between the methods this replaces:
 *
 * - **Suspension** passes nothing. Suspending an administrator always removes
 *   one, so the only question is whether they are the last.
 * - **A role change** passes the role being granted. Promoting somebody *to*
 *   `ADMIN` adds an administrator and can never leave us short, so it returns
 *   early — checking the count there would refuse the one action that fixes the
 *   problem the rule exists to prevent.
 *
 * A target who is not currently an administrator is never a concern either way.
 */
export async function refuseIfLastAdministrator(
  users: UserDirectory,
  target: MirroredUser,
  becomingRole?: UserRole,
): Promise<void> {
  if (becomingRole === 'ADMIN') return;
  if (target.role !== 'ADMIN') return;

  const administrators = await users.countAdministrators();
  if (administrators <= 1) {
    throw new ApprovalRefusedError(
      'that is the last administrator — promote somebody else first',
    );
  }
}
