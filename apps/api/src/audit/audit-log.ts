/**
 * The audit trail, as the rest of the application sees it.
 *
 * **There is no update and no delete, and that absence is the design.** BRD
 * §17's risk table calls for immutable audit logs; a port offering an edit is a
 * port somebody eventually edits from. Making append-only a property of the
 * type means the guarantee cannot be broken without a visible change to this
 * file — rather than by a plausible-looking line in whichever service needed to
 * "correct" an entry.
 *
 * Modules record through this interface and never touch `audit_logs` directly,
 * the same boundary rule that keeps Profiles out of `users` (BRD §5.1).
 */

/**
 * Everything that can be audited, enumerated.
 *
 * A closed union rather than a free string, so a typo is a compile error and
 * the vocabulary can be read in one place. It is deliberately *not* a Postgres
 * enum — that would put every new audited action in every future module behind
 * a schema migration.
 *
 * Dotted and past tense: the log records what happened, not what was asked for.
 */
export type AuditAction =
  /** A session was seen for an account we had no mirror row for, so one was made. */
  | 'account.provisioned'
  /** An administrator read somebody else's activity. A disclosure, so audited. */
  | 'admin.activity_viewed'
  | 'profile.created'
  | 'profile.updated'
  /**
   * Somebody asked to be deleted. Recorded on the account, and **retained**
   * after the erasure it describes — §10.1 keeps security logs six years, and
   * "when did they ask, and did you act" is precisely what an enquiry asks.
   * The entry survives because it holds digests, not values (ADR 0017).
   */
  | 'account.deletion_requested'
  /** The personal data a module held about somebody was removed. */
  | 'profile.erased'
  /**
   * Everything held about somebody was assembled and handed to them.
   *
   * Audited because it is the one bulk disclosure the platform performs, and
   * the only path by which a decrypted address leaves the database (ADR 0019).
   * An access log with a hole exactly where the sensitive operation is would be
   * worse than none.
   */
  | 'account.exported'
  /**
   * The mirrored email address was corrected to match the provider's.
   *
   * Security-relevant out of proportion to how ordinary it looks: changing the
   * address on an account is how a takeover is made permanent, and it is the
   * one identity fact that can change without anything else about the account
   * changing. Recorded whichever path corrected it (ADR 0020).
   */
  | 'account.email_changed';

/**
 * Who did it, and from where.
 *
 * Passed explicitly rather than read from an ambient request context. The
 * correlation id uses AsyncLocalStorage (ADR 0007) and that is right for
 * something every log line wants; an actor is different — a service that can
 * reach for one implicitly is a service where "whose action was this" has no
 * answer in the type, and admin impersonation later makes that distinction
 * load-bearing.
 */
export interface Actor {
  readonly userId: string;

  /**
   * The client's address, or null when it is genuinely not known.
   *
   * Null is common and not a defect: the API is not reachable from the
   * internet, so it never sees a browser and this value is only as good as the
   * hop that forwarded it. See ADR 0017 for what that is worth.
   */
  readonly ipAddress: string | null;
}

/** One thing that happened, ready to store. Digests, never values. */
export interface AuditEntry {
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly ipAddress: string | null;

  /**
   * Why, for actions that owe an explanation.
   *
   * Null for an ordinary user action — somebody editing their own profile is
   * not accountable to anyone for it. Required of administrative actions, where
   * BRD §8.13 asks for "actor, reason, target and before/after state", and
   * enforced by the admin routes rather than by this type (ADR 0021).
   */
  readonly reason: string | null;
}

/** A stored entry, as its own actor may read it back. */
export interface RecordedEntry {
  readonly id: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly reason: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
}

/**
 * An entry recording something *somebody else* did to this account.
 *
 * A separate type from `RecordedEntry`, not the same one with a nulled field,
 * for the reason ADR 0016 gives about profiles: an optional `ipAddress?: string`
 * compiles identically whether or not the store remembered to drop it, so the
 * guarantee would live in whichever query somebody edits next.
 *
 * **There is no `ipAddress`, and its absence is the point.** On these entries
 * the address belongs to the *actor* — an administrator — not to the person
 * reading them. Handing a support worker's home address to the account they
 * were asked to investigate is a safety problem, and it is the kind that only
 * becomes visible after it has happened.
 */
export interface DisclosedEntry {
  readonly id: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly reason: string | null;
  readonly createdAt: Date;

  /**
   * Whether a person did this, as opposed to it happening automatically.
   *
   * A boolean rather than an actor id, because the subject has no business
   * knowing *which* administrator read their account — only that one did, when,
   * and why. False means the entry has no actor at all: a provider webhook
   * applied a change that nobody was holding a session for.
   */
  readonly byAnotherUser: boolean;
}

export interface AuditLog {
  /**
   * Append one entry.
   *
   * **Failures propagate.** The alternative — catching and continuing — means
   * the audited action succeeds with no record of it, which is the one outcome
   * an audit log exists to prevent. In practice this table shares a database
   * with the data being changed, so a failure here means the change would have
   * failed too. ADR 0017.
   */
  record(entry: AuditEntry): Promise<void>;

  /** An actor's own entries, newest first. There is no "everyone's" query yet. */
  listForActor(actorId: string, limit: number): Promise<readonly RecordedEntry[]>;

  /**
   * Entries where this account was the **target** of somebody else's action.
   *
   * The other half of a person's history, and the half that was missing.
   * `listForActor` answers "what did I do"; without this, an administrator
   * reading your account was recorded against *them* and appeared nowhere you
   * could see it — which made BRD §8.13's reason requirement a note in a table
   * rather than a control (ADR 0021's correction).
   *
   * Excludes entries this account is itself the actor of, so an action on your
   * own row — `account.provisioned`, `account.deletion_requested` — is not
   * returned twice when the two lists are merged.
   */
  listForSubject(subjectId: string, limit: number): Promise<readonly DisclosedEntry[]>;
}
