/**
 * Reading and writing profiles and addresses.
 *
 * Narrow for the same reason `UserDirectory` is: the service needs three
 * operations and gets three. Handing it a `PrismaClient` would let a later
 * change reach `users` from inside this module, which is the cross-module write
 * CLAUDE.md bans — and this module in particular must never write to `users`,
 * because BRD §5.1 gives accounts to Identity & Access.
 *
 * The port speaks in **plaintext**. Encryption is the adapter's business: a
 * service that had to remember to encrypt before every save is a service that
 * will eventually forget on one path.
 */

/** A postal address as the domain understands it — all of it, in clear. */
export interface AddressDetail {
  readonly line1: string;
  readonly line2: string | null;
  readonly town: string;
  /** Normalised, e.g. `BS7 8AA`. */
  readonly postcode: string;
}

/** A stored profile, as its owner may see it. */
export interface StoredProfile {
  readonly userId: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: AddressDetail | null;
  readonly updatedAt: Date;
}

/** What a save carries. Absent address means "leave it as it is". */
export interface ProfileChanges {
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: AddressDetail | null;
}

/**
 * Raised when a write loses a race with a concurrent one — two tabs saving the
 * same new profile at once, most realistically. The caller re-reads rather than
 * surfacing a 500, because the constraint firing means the row now exists.
 */
export class ProfileConflictError extends Error {
  constructor(cause?: unknown) {
    super('profile write conflicted with a concurrent write');
    this.name = 'ProfileConflictError';
    this.cause = cause;
  }
}

export interface ProfileStore {
  find(userId: string): Promise<StoredProfile | null>;

  /**
   * Create or replace the profile for `userId`.
   *
   * Replace rather than merge, and the whole object rather than a patch: a
   * partial update needs the caller to say the difference between "leave the
   * phone alone" and "clear the phone", and every encoding of that distinction
   * over HTTP is a source of accidental data loss. The form sends everything it
   * knows; the store writes everything it is given.
   *
   * Throws `ProfileConflictError` when the insert loses a race.
   */
  save(userId: string, changes: ProfileChanges): Promise<StoredProfile>;
}

/**
 * What this module needs to know about an account, and nothing more.
 *
 * A port rather than a direct call into the identity module: Profiles & Trust
 * declares the question it has — "is this a real, active account, and when did
 * they join" — and the composition root supplies an answer backed by Identity &
 * Access. Neither module imports the other's internals, and this one can be
 * tested without an identity service at all.
 */
export interface Account {
  readonly id: string;
  readonly createdAt: Date;
}

export interface AccountLookup {
  /** Null for an account that does not exist *or* has been deleted. */
  findActive(userId: string): Promise<Account | null>;
}
