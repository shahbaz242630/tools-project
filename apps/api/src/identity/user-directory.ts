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
}
