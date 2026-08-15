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

import type { OwnerStatus } from '@platform/contracts';

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
  /**
   * The profile row's own identifier.
   *
   * Here so an audit entry can name what it changed. Using `userId` as the
   * target would work today, when profiles are one-per-account, and would be
   * quietly wrong the moment that stops being true — an audit trail is the last
   * place to leave an ambiguous reference.
   */
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: AddressDetail | null;
  /**
   * Whether they list as themselves or as a business — BRD §8.3's consumer-law
   * disclosure (slice 2.13, ADR 0043).
   *
   * **Null means "has not answered", and never "probably private".** The
   * publication gate reads it as unanswered and refuses; a default here would
   * have the platform answering a legal question on somebody's behalf.
   */
  readonly ownerStatus: OwnerStatus | null;
  readonly updatedAt: Date;
}

/** What a save carries. Absent address means "leave it as it is". */
export interface ProfileChanges {
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: AddressDetail | null;
  /**
   * Null clears the declaration, which is a real thing to want: somebody who
   * answered "business", was told we cannot publish those, and wants to think
   * again should not be stuck with the answer. It is not "leave it alone" — the
   * form posts every field, as the listing edit does, for the reason
   * `ListingEdit` gives about partials.
   */
  readonly ownerStatus: OwnerStatus | null;
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
   * The declared owner status of many people, in one round trip.
   *
   * **Plural because the caller is plural.** Catalogue hydrates a whole page of
   * search results and needs one answer per distinct owner; asking `find` in a
   * loop is the N+1 that slice 3.1a's gap list recorded, and moving that loop
   * from Catalogue into Profiles only changed which module paid for it.
   *
   * **A map with no entry, not a null value.** Absence means nobody has
   * declared anything — which covers both "no profile row" and "a profile that
   * has not answered", conflated on purpose exactly as `findOwnerStatus` does.
   * A `Map<string, OwnerStatus | null>` would offer a third state that means
   * the same as the second and invite a branch that reads one of them as
   * consent.
   *
   * Returns only what it found: callers must not assume every id is a key.
   */
  findOwnerStatuses(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, OwnerStatus>>;

  /**
   * Remove everything this module holds about a person.
   *
   * A real delete, not a flag: this is what a deletion request is *for*, and a
   * soft-deleted profile row would leave the display name and the encrypted
   * address sitting in the database with no purpose and a retention clock
   * nobody is watching (BRD §10.1). The `users` row survives instead, because
   * the ledger will need a counterparty — that is the record we are obliged to
   * keep, and it is not this one.
   *
   * **Idempotent.** Erasing twice is a success, not an error: a retry after a
   * partial failure must be able to finish the job.
   */
  erase(userId: string): Promise<void>;

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
