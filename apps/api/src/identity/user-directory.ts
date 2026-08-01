/**
 * Reading and writing the identity mirror.
 *
 * Narrow on purpose. The service above it needs four operations and gets four;
 * handing it a `PrismaClient` would let any later change reach the whole schema
 * from inside the identity module, which is the cross-module write CLAUDE.md
 * bans. It also makes the tombstoning and already-deleted paths unit-testable
 * without a database, which is where the subtle mistakes live.
 */

export type UserRole = 'USER' | 'ADMIN';

/** Our row. `id` is the platform identity; `clerkUserId` is a reference. */
export interface MirroredUser {
  readonly id: string;
  readonly clerkUserId: string;
  readonly email: string;
  readonly role: UserRole;
  readonly deletedAt: Date | null;
  readonly deletionRequestedAt: Date | null;

  /**
   * When an administrator suspended the account, or null.
   *
   * **Not a variant of deletion.** Deletion is the person's own request and
   * erases their data; suspension is done *to* them, is reversible, and
   * destroys nothing. The guard treats them differently for that reason: a
   * deleted session is refused outright, a suspended one is allowed through to
   * the routes that carry data-protection rights (ADR 0024).
   */
  readonly suspendedAt: Date | null;

  /**
   * Why, in the administrator's words — and shown to the suspended person.
   *
   * The same bargain ADR 0021 struck for administrative reads: whoever writes
   * it knows who will read it, which is what makes it a control rather than a
   * box to clear.
   */
  readonly suspensionReason: string | null;

  /**
   * When the account was mirrored — effectively when the person joined.
   *
   * Here because the public profile shows "member since", and taking that from
   * the profile row instead would date somebody from when they filled in a form
   * rather than from when they signed up.
   */
  readonly createdAt: Date;
}

/** The row, and whether this call is the one that brought it into existence. */
export interface UpsertResult {
  readonly user: MirroredUser;
  readonly created: boolean;
}

export interface UpsertUserInput {
  readonly clerkUserId: string;
  readonly email: string;
}

export interface UserChanges {
  readonly email?: string;
  readonly deletedAt?: Date;

  /**
   * When the person asked, as distinct from when we acted.
   *
   * Separate from `deletedAt` because a provider webhook can tombstone an
   * account that nobody asked us about, and recording a request in that case
   * would fabricate the one fact a data-protection enquiry cares about.
   */
  readonly deletionRequestedAt?: Date;
}

/**
 * Raised when a write loses a race with a concurrent one — a duplicate webhook
 * delivery arriving while a first request is provisioning the same user, most
 * realistically. The caller retries a read rather than surfacing a 500, because
 * the constraint firing means the row now exists.
 */
export class UserConflictError extends Error {
  constructor(cause?: unknown) {
    super('user write conflicted with a concurrent write');
    this.name = 'UserConflictError';
    this.cause = cause;
  }
}

export interface UserDirectory {
  findByClerkUserId(clerkUserId: string): Promise<MirroredUser | null>;

  /**
   * Look up by our own identifier.
   *
   * Added for the profiles module, which is handed a `userId` from a public URL
   * and must decide whether that account exists and is still active. It asks
   * through the identity service rather than reading `users` itself — the
   * cross-module read CLAUDE.md bans.
   */
  findById(id: string): Promise<MirroredUser | null>;

  /**
   * Create the mirror row, or return the existing one.
   *
   * Reports **whether it created**, because "this account came into existence"
   * is an auditable event and "we looked one up" is not. Deriving that from a
   * read beforehand would be a lie under concurrency: two requests both see no
   * row, both call this, and one of them is wrong.
   *
   * Throws `UserConflictError` when the insert loses a race, rather than
   * swallowing it — the caller decides whether re-reading is the right
   * response, and silently returning stale state is how mirrors drift.
   */
  upsert(input: UpsertUserInput): Promise<UpsertResult>;

  update(id: string, changes: UserChanges): Promise<MirroredUser>;

  /**
   * How many administrators can actually administer anything.
   *
   * Exists for exactly one rule: refusing a demotion that would leave nobody
   * able to administer anything. Role assignment is itself behind dual approval
   * (ADR 0023), so demoting the last administrator would need two
   * administrators to undo and leave one — recovery would be a database write
   * on a production box.
   *
   * **Suspended administrators do not count**, and neither do deleted ones.
   * Both hold the role and neither can use it, so counting them would let the
   * last usable administrator be demoted on the strength of somebody who
   * cannot sign in — which is the lockout this rule exists to prevent, arrived
   * at by a different route (ADR 0024).
   *
   * A count rather than a list, because the rule needs a number and handing out
   * the administrators would be a disclosure nothing has asked for.
   *
   * **There is deliberately no `promote` here.** Changing a role is an
   * administrative action with its own route, reason, second approver and audit
   * entry; a port method that did it directly would be an ungoverned way round
   * all four.
   */
  countAdministrators(): Promise<number>;
}
