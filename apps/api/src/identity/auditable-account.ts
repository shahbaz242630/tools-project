import type { MirroredUser } from './user-directory.js';

/**
 * The part of an account whose state is worth digesting.
 *
 * The email is included because a change to it is exactly what a later
 * `account.updated` entry would need to prove — and it is only ever hashed, so
 * the address itself does not reach the log. `clerkUserId` is left out: it is a
 * provider reference that says nothing about the account's own state.
 *
 * **Its own module from slice H4.** All four services the identity module split
 * into digest an account — the mirror on provision and email correction,
 * administration on suspension, role changes on approval, and erasure on
 * deletion — so it cannot live in any one of them without the other three
 * importing a sibling service for a pure function. What it must never become is
 * four copies: two entries that digest the same account differently would
 * compare as a change when nothing changed, which destroys the only thing
 * comparing digests is for (ADR 0017).
 */
export function auditableAccount(user: MirroredUser): unknown {
  return {
    id: user.id,
    email: user.email,
    role: user.role,

    /**
     * Whether the account is suspended — a boolean, not the timestamp.
     *
     * It has to be here or a suspension would digest identically before and
     * after, and the entry would claim nothing changed about the one thing that
     * did. A boolean rather than `suspendedAt` for the reason `updatedAt` is
     * excluded entirely: the state is what a reader compares, and a timestamp
     * would make a re-suspension with identical circumstances look like a
     * different change.
     */
    suspended: user.suspendedAt !== null,
  };
}
