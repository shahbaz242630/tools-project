import type { Actor, AuditAction, AuditLog, RecordedEntry } from './audit-log.js';
import type { StateDigest } from './state-digest.js';

/**
 * The audit module's application service.
 *
 * Thin on purpose. Its one job is that **callers hand over state and never
 * digests** — if every module computed its own hash, they would disagree about
 * canonical form the first time one of them passed a `Date`, and two entries
 * for the same change would compare as different. Hashing in exactly one place
 * is what makes the digests comparable at all.
 *
 * It is also the seam where "what may be audited" is enforced: `AuditAction` is
 * a closed union, so a new kind of event is a deliberate edit to the vocabulary
 * rather than a string somebody invents at a call site.
 */

/** How many entries a person's own activity view returns. */
export const DEFAULT_ACTIVITY_LIMIT = 50;

/**
 * The largest page anyone may ask for.
 *
 * An engineering bound on one query's cost, not a business rule — there is no
 * pagination yet, and a caller asking for everything would read an entire audit
 * history into memory to render fifty rows.
 */
export const MAX_ACTIVITY_LIMIT = 200;

export interface RecordChange {
  readonly actor: Actor | null;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;

  /** Absent for a creation — there was no prior state to digest. */
  readonly before?: unknown;
  /** Absent for a deletion — there is no resulting state. */
  readonly after?: unknown;
}

export class AuditService {
  constructor(
    private readonly log: AuditLog,
    private readonly digest: StateDigest,
  ) {}

  /**
   * Record that something changed.
   *
   * Awaited by callers, and its failures are theirs to propagate: an action
   * that succeeded without an audit entry is exactly what this module exists to
   * make impossible.
   */
  async record(change: RecordChange): Promise<void> {
    await this.log.record({
      actorId: change.actor?.userId ?? null,
      action: change.action,
      targetType: change.targetType,
      targetId: change.targetId,

      // `undefined` means "no such state", which is different from a state that
      // happens to be empty — a creation has no before, and digesting one would
      // claim a prior version existed.
      beforeHash: change.before === undefined ? null : this.digest.of(change.before),
      afterHash: change.after === undefined ? null : this.digest.of(change.after),

      ipAddress: change.actor?.ipAddress ?? null,
    });
  }

  /**
   * An actor's own activity.
   *
   * Takes the id from the caller's session, never from a parameter — the same
   * reasoning as `/me/profile`. There is deliberately no way to ask for
   * somebody else's, so the ownership check cannot be forgotten because it does
   * not exist.
   */
  listForActor(
    actorId: string,
    limit = DEFAULT_ACTIVITY_LIMIT,
  ): Promise<readonly RecordedEntry[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_ACTIVITY_LIMIT);
    return this.log.listForActor(actorId, bounded);
  }
}
