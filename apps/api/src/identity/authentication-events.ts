/**
 * Sign-ins and sign-outs, as the rest of the application sees them.
 *
 * BRD §8.1's "authentication events" — the record a person reads to answer
 * "has anybody else been in my account". Identity & Access owns it, because
 * §5.1 gives that module accounts, roles and sessions.
 *
 * **Deliberately not part of `AuditLog`**, and the reason is worth stating
 * where somebody will find it. The audit trail stores keyed digests rather than
 * values so it can be retained for six years without holding personal data
 * (ADR 0017). A sign-in record is the exact opposite trade: it is useless
 * unless it holds the city, the browser and the address in plain form, because
 * nobody recognises an intruder from an HMAC. Two different retention and
 * disclosure positions want two tables, not one table with seven columns that
 * every other audited action leaves null — the optional-field trap ADR 0016
 * rejected for profiles. ADR 0025.
 *
 * There is no update and no delete, for the reason `AuditLog` has neither.
 * `eraseActivity` is not an exception to that: it nulls the personal columns of
 * rows that stay where they are, which is a redaction rather than a rewrite.
 */

/**
 * What happened to a session.
 *
 * **Our vocabulary, not Clerk's.** Clerk sends `session.created`,
 * `session.ended`, `session.removed` and `session.revoked`; the mapper
 * translates, so nothing above this line knows which provider we chose — the
 * same boundary `SessionVerifier` draws for tokens.
 *
 * The four are kept distinct rather than collapsed into "started" and "stopped"
 * because they answer different questions for somebody checking their account.
 * `ended` is an ordinary sign-out. `revoked` means somebody deliberately killed
 * the session — possibly the account holder from another device, possibly not —
 * and that is precisely the line a person scanning for an intrusion is looking
 * for. Collapsing them would hide it.
 */
export type AuthenticationEventType = 'started' | 'ended' | 'removed' | 'revoked';

/** The four, as a value, for validating anything arriving from outside. */
export const AUTHENTICATION_EVENT_TYPES: readonly AuthenticationEventType[] = [
  'started',
  'ended',
  'removed',
  'revoked',
];

/**
 * Where a session was used from, as Clerk's geo-location resolved it.
 *
 * **Every field is nullable, and that is the provider's shape rather than
 * defensiveness.** `latest_activity` is optional on Clerk's session payload and
 * each field inside it is optional again. A correctly delivered event can carry
 * none of this, and the honest record of that is null — inventing a value to
 * fill a column would put a guess into a security record somebody may rely on.
 *
 * A single object rather than seven loose parameters so that "we know nothing
 * about this session" has one obvious representation, and so adding a field
 * later does not change every call site.
 */
export interface SessionActivity {
  /**
   * The address Clerk saw, which is **not** the address our own audit log
   * records for a request.
   *
   * `audit_logs.ipAddress` is what the web app forwarded to us on `x-client-ip`
   * (ADR 0017); this is what the client presented to Clerk. They usually agree
   * and are allowed to differ — a person signing in through a VPN that they
   * then turn off produces two truthful and different answers.
   *
   * Frequently IPv6 in practice. It lands in an `inet` column, so a malformed
   * value throws on insert; it is validated before it gets there.
   */
  readonly ipAddress: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly browserName: string | null;
  readonly browserVersion: string | null;
  readonly deviceType: string | null;
  readonly isMobile: boolean | null;
}

/** Nothing known about the session beyond that it existed. */
export const NO_SESSION_ACTIVITY: SessionActivity = {
  ipAddress: null,
  city: null,
  country: null,
  browserName: null,
  browserVersion: null,
  deviceType: null,
  isMobile: null,
};

/** One authentication event, ready to store. */
export interface AuthenticationEventRecord {
  /** Our `users.id`, never Clerk's. Resolved by the caller before we get here. */
  readonly userId: string;

  /** Clerk's `sess_…`. A reference to the provider's record, not an identity. */
  readonly clerkSessionId: string;

  readonly event: AuthenticationEventType;

  /**
   * When it happened at Clerk, not when we stored it.
   *
   * Webhooks are asynchronous and redeliverable, so the two genuinely differ
   * and only this one answers "when was I signed in".
   */
  readonly occurredAt: Date;

  readonly activity: SessionActivity;
}

/** A stored event, as the account holder reads it back. */
export interface RecordedAuthenticationEvent {
  readonly id: string;
  readonly clerkSessionId: string;
  readonly event: AuthenticationEventType;
  readonly occurredAt: Date;
  readonly activity: SessionActivity;
}

export interface AuthenticationEvents {
  /**
   * Append one event.
   *
   * **Idempotent, and it has to be.** The `webhook_events` ledger already
   * refuses a redelivered *delivery*, but it cannot see the same logical event
   * arriving under two delivery ids, which a provider replay does produce. A
   * second call for the same session and event type is a success that stores
   * nothing — a handler that threw here would be one Clerk retries forever
   * (CLAUDE.md's idempotency invariant).
   *
   * **Failures propagate**, unlike the duplicate case. An event we were told
   * about and did not store is a hole in a security record, and the caller —
   * the webhook path — wants the provider to retry.
   */
  record(event: AuthenticationEventRecord): Promise<void>;

  /** This account's events, newest first. */
  listFor(
    userId: string,
    limit: number,
  ): Promise<readonly RecordedAuthenticationEvent[]>;

  /**
   * Redact the personal columns, keeping the rows.
   *
   * Called when an account is erased. §10.1 retains security logs for six
   * years, and "a session started at 14:02" is the part that can honestly be
   * retained; "from Edge on Windows in Dubai" is the personal data that must
   * go. Deleting the rows outright would also fight the `ON DELETE RESTRICT`
   * foreign key for no gain.
   *
   * **Must be idempotent** — a retry after a partial failure has to be able to
   * finish, and redacting what is already redacted is a success.
   */
  eraseActivity(userId: string): Promise<void>;
}
