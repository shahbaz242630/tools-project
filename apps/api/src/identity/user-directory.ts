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
}

export interface UpsertUserInput {
  readonly clerkUserId: string;
  readonly email: string;
}

export interface UserChanges {
  readonly email?: string;
  readonly deletedAt?: Date;
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
   * Create the mirror row, or return the existing one.
   *
   * Throws `UserConflictError` when the insert loses a race, rather than
   * swallowing it — the caller decides whether re-reading is the right
   * response, and silently returning stale state is how mirrors drift.
   */
  upsert(input: UpsertUserInput): Promise<MirroredUser>;

  update(id: string, changes: UserChanges): Promise<MirroredUser>;
}
