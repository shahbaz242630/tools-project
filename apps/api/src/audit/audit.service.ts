import { Paging } from '@platform/core';
import type {
  Actor,
  AuditAction,
  AuditLog,
  DisclosedEntry,
  RecordedEntry,
} from './audit-log.js';
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

/**
 * Who did the thing, from the reader's point of view.
 *
 * `subject` rather than `you`, because the same trail is served to two readers:
 * the person themselves, and an administrator looking at their account. "You"
 * would be a lie on the second page, and a vocabulary that means different
 * things depending on who is reading it is one somebody eventually renders
 * wrong.
 *
 * `administrator` is a claim about *today's* routes: the only way one account
 * acts on another is through the admin surface, which requires the role and a
 * second factor (ADR 0021). The store below knows only "another user", so if a
 * non-administrative cross-account action is ever added, this mapping is what
 * has to change — and it is one expression in one file.
 */
export type ActivityActor = 'subject' | 'administrator' | 'system';

/** One entry in the merged trail, whichever direction it came from. */
export interface ActivityRecord {
  readonly id: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly reason: string | null;

  /**
   * Always null for an entry the reader was not the actor of.
   *
   * Not "unknown" — deliberately withheld. On those rows the address belongs to
   * the administrator who acted, and it is not the subject's to see.
   */
  readonly ipAddress: string | null;

  /**
   * Which sign-in it happened in, or null — **and always null unless `by` is
   * `subject`**, exactly like `ipAddress` above.
   *
   * On somebody else's action the session is the administrator's, and the
   * reader has no more business with it than with their address.
   */
  readonly sessionId: string | null;
  readonly createdAt: Date;
  readonly by: ActivityActor;
}

export interface RecordChange {
  readonly actor: Actor | null;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;

  /** Absent for a creation — there was no prior state to digest. */
  readonly before?: unknown;
  /** Absent for a deletion — there is no resulting state. */
  readonly after?: unknown;

  /** Why. Required of admin actions by their routes, absent for user actions. */
  readonly reason?: string;
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

      // Comes off the `Actor` rather than being a parameter of its own, because
      // "who did it, and from where" is one fact and splitting it across two
      // arguments is how one of them gets forgotten at a call site.
      sessionId: change.actor?.sessionId ?? null,

      reason: change.reason ?? null,
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
    return this.log.listForActor(actorId, this.bound(limit));
  }

  /**
   * Everything on one account: what they did, and what was done to them.
   *
   * The second half is the part that was missing. An administrator reading
   * somebody's account is recorded with the administrator as actor, so it only
   * ever appeared in the administrator's own trail — and BRD §8.13's reason
   * requirement is only a control if the person it was written for can read it
   * (ADR 0021's correction).
   *
   * Both sides are fetched at the full limit and merged down to it, which is
   * correct rather than merely convenient: the newest `n` overall are
   * necessarily among the newest `n` of each side.
   */
  async listActivityFor(
    userId: string,
    limit = DEFAULT_ACTIVITY_LIMIT,
  ): Promise<readonly ActivityRecord[]> {
    const bounded = this.bound(limit);

    const [own, disclosed] = await Promise.all([
      this.log.listForActor(userId, bounded),
      this.log.listForSubject(userId, bounded),
    ]);

    return [...own.map(asOwnAction), ...disclosed.map(asDisclosure)]
      .sort(newestFirst)
      .slice(0, bounded);
  }

  /**
   * Clamp a caller's page size.
   *
   * Delegates to the shared clamp from slice H2. It was four operations written
   * here and again in `identity.service.ts`, and **the two disagreed**: this copy
   * had no guard for a non-finite request, so `NaN` survived every clamp and
   * reached Prisma as `take: NaN`. Unreachable today only because both callers
   * use the default, which is a property of today's routes rather than of this
   * code.
   */
  private bound(limit: number): number {
    return Paging.boundedLimit(limit, {
      fallback: DEFAULT_ACTIVITY_LIMIT,
      max: MAX_ACTIVITY_LIMIT,
    });
  }
}

function asOwnAction(entry: RecordedEntry): ActivityRecord {
  return { ...entry, by: 'subject' };
}

function asDisclosure(entry: DisclosedEntry): ActivityRecord {
  const { byAnotherUser, ...rest } = entry;
  return {
    ...rest,
    // Null, not absent, and not the actor's. See `ActivityRecord.ipAddress`.
    ipAddress: null,
    // Same rule, same reason. `DisclosedEntry` carries no session to leak, so
    // this is stating the guarantee rather than enforcing it — the type already
    // did that. Written out so the two withheld fields read alike.
    sessionId: null,
    by: byAnotherUser ? 'administrator' : 'system',
  };
}

/**
 * Newest first, breaking ties on id.
 *
 * The tiebreak is not decoration. `createdAt` is `timestamptz(3)`, so two
 * entries written in the same millisecond — which is the *normal* case for an
 * admin read, since the disclosure is recorded immediately before the query
 * that returns it — compare equal, and `Array.prototype.sort` would then order
 * them by whichever list happened to be concatenated first. Falling through to
 * the id makes the answer stable across calls, which is all a reader needs.
 */
function newestFirst(a: ActivityRecord, b: ActivityRecord): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}
