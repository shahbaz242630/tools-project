/**
 * Test doubles for the identity module.
 *
 * BRD §5 requires a fake alongside every provider adapter. These are the fakes
 * for the session verifier, and in-memory stand-ins for the two persistence
 * ports so the service's rules can be tested without Postgres.
 *
 * They are *behavioural*, not recording spies. A double that merely records
 * what it was handed lets a test pass while the mechanism under it is broken —
 * a lesson this project has already paid for once with the correlation logger.
 * The directory below therefore enforces both unique constraints, because the
 * behaviour worth testing is what happens when one of them fires.
 */

import { Time } from '@platform/core';
import { createAuditFakes } from '../../audit/testing/fakes.js';
import type { AuditFakes } from '../../audit/testing/fakes.js';
import { IdentityService } from '../identity.service.js';
import { SessionVerificationError } from '../session-verifier.js';
import type { SessionVerifier, VerifiedSession } from '../session-verifier.js';
import { UserConflictError } from '../user-directory.js';
import type {
  MirroredUser,
  UpsertResult,
  UpsertUserInput,
  UserChanges,
  UserDirectory,
} from '../user-directory.js';
import type { WebhookDelivery, WebhookLedger } from '../webhook-ledger.js';
import type { Actor } from '../../audit/audit-log.js';
import type { PersonalDataEraser } from '../personal-data-eraser.js';
import type { PersonalDataSource } from '../personal-data-source.js';
import type { ProfileSummarySource } from '../profile-summary-source.js';
import { ApprovalConflictError } from '../admin-approval.js';
import type {
  AdminApproval,
  AdminApprovalStore,
  ApprovalDecision,
  ProposeApproval,
} from '../admin-approval.js';
import type { AdminProfile, ExportedProfile } from '@platform/contracts';

/**
 * What a test supplies for a session.
 *
 * `secondFactorAgeMinutes` is optional and **defaults to null — no second
 * factor**. Fail-closed in the double as well as in production: a test that
 * expects to reach an admin route has to say so, rather than inheriting
 * privilege from a fixture nobody reread.
 */
export type SessionInput = Omit<VerifiedSession, 'secondFactorAgeMinutes'> &
  Partial<Pick<VerifiedSession, 'secondFactorAgeMinutes'>>;

/** Accepts exactly the tokens it was given, rejects everything else. */
export class FakeSessionVerifier implements SessionVerifier {
  private readonly sessions = new Map<string, VerifiedSession>();

  accept(token: string, session: SessionInput): this {
    this.sessions.set(token, {
      ...session,
      secondFactorAgeMinutes: session.secondFactorAgeMinutes ?? null,
    });
    return this;
  }

  verify(token: string): Promise<VerifiedSession> {
    const session = this.sessions.get(token);
    if (session === undefined) {
      return Promise.reject(new SessionVerificationError(new Error('unknown token')));
    }
    return Promise.resolve(session);
  }
}

export class InMemoryUserDirectory implements UserDirectory {
  private readonly rows = new Map<string, MirroredUser>();
  private nextId = 1;

  /** Deterministic ids: a failing assertion should name a stable value. */
  private mintId(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }

  seed(user: MirroredUser): this {
    this.rows.set(user.id, user);
    return this;
  }

  /**
   * Make an existing row an administrator.
   *
   * **Test-only, and deliberately not on `UserDirectory`.** Granting a role is
   * an administrative action that will need its own route, its own reason and
   * its own audit entry when it arrives; adding it to the production port now
   * would create an ungoverned way to do it. Until that slice exists, tests
   * that need an admin say so here.
   */
  promote(id: string): this {
    const existing = this.rows.get(id);
    if (existing === undefined) throw new Error(`no such user: ${id}`);
    this.rows.set(id, { ...existing, role: 'ADMIN' });
    return this;
  }

  all(): readonly MirroredUser[] {
    return [...this.rows.values()];
  }

  findByClerkUserId(clerkUserId: string): Promise<MirroredUser | null> {
    const found = [...this.rows.values()].find(
      (row) => row.clerkUserId === clerkUserId,
    );
    return Promise.resolve(found ?? null);
  }

  findById(id: string): Promise<MirroredUser | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  /**
   * Suspend or reinstate a row. **Test-only, and deliberately not on the port.**
   *
   * Suspension has no production route until slice 1.10b; until then it is a
   * database write, the same escape hatch role assignment used before 1.9.
   * Enforces the all-or-nothing shape the CHECK constraint enforces, so a test
   * cannot set a state Postgres would refuse.
   */
  suspend(id: string, byId: string, reason: string): this {
    const existing = this.rows.get(id);
    if (existing === undefined) throw new Error(`no such user: ${id}`);
    this.rows.set(id, {
      ...existing,
      suspendedAt: Time.nowUtc(),
      suspensionReason: reason,
    });
    void byId;
    return this;
  }

  reinstate(id: string): this {
    const existing = this.rows.get(id);
    if (existing === undefined) throw new Error(`no such user: ${id}`);
    this.rows.set(id, { ...existing, suspendedAt: null, suspensionReason: null });
    return this;
  }

  countAdministrators(): Promise<number> {
    // Usable only, matching the real store. A deleted administrator cannot sign
    // in and a suspended one is refused every admin route, so counting either
    // would let the last usable one be demoted on the strength of somebody who
    // cannot act.
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) =>
          row.role === 'ADMIN' && row.deletedAt === null && row.suspendedAt === null,
      ).length,
    );
  }

  async upsert(input: UpsertUserInput): Promise<UpsertResult> {
    const existing = await this.findByClerkUserId(input.clerkUserId);
    if (existing !== null) return { user: existing, created: false };

    // The email constraint is case-insensitive in Postgres because the column
    // is citext. Folding here keeps the double honest about that.
    const emailTaken = [...this.rows.values()].some(
      (row) => row.email.toLowerCase() === input.email.toLowerCase(),
    );
    if (emailTaken) throw new UserConflictError();

    const user: MirroredUser = {
      id: this.mintId(),
      clerkUserId: input.clerkUserId,
      email: input.email,
      role: 'USER',
      deletedAt: null,
      deletionRequestedAt: null,
      suspendedAt: null,
      suspensionReason: null,
      // Fixed rather than `new Date()`: "member since" is rendered from this,
      // and a test asserting the rendered month must not depend on the clock
      // the suite happens to run under.
      createdAt: Time.fromIsoUtc('2026-07-15T09:00:00.000Z'),
    };
    this.rows.set(user.id, user);
    return { user, created: true };
  }

  update(id: string, changes: UserChanges): Promise<MirroredUser> {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      return Promise.reject(new Error(`no such user: ${id}`));
    }

    // The email constraint applies to updates, not only to inserts — and the
    // real store surfaces a collision here as `UserConflictError`. A double
    // that enforced it on `upsert` alone would let a test pass while the
    // behaviour it is checking could not happen, which is exactly what this
    // file's header warns against. Case-folded, because the column is citext.
    if (changes.email !== undefined) {
      const taken = [...this.rows.values()].some(
        (row) =>
          row.id !== id && row.email.toLowerCase() === changes.email?.toLowerCase(),
      );
      if (taken) return Promise.reject(new UserConflictError());
    }

    const updated: MirroredUser = {
      ...existing,
      ...(changes.email === undefined ? {} : { email: changes.email }),
      ...(changes.deletedAt === undefined ? {} : { deletedAt: changes.deletedAt }),
      ...(changes.deletionRequestedAt === undefined
        ? {}
        : { deletionRequestedAt: changes.deletionRequestedAt }),
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryWebhookLedger implements WebhookLedger {
  private readonly claimed = new Map<string, { processedAt: Date | null }>();

  private static key(provider: string, externalId: string): string {
    return `${provider}:${externalId}`;
  }

  claim(delivery: WebhookDelivery): Promise<boolean> {
    const key = InMemoryWebhookLedger.key(delivery.provider, delivery.externalId);
    if (this.claimed.has(key)) return Promise.resolve(false);
    this.claimed.set(key, { processedAt: null });
    return Promise.resolve(true);
  }

  markProcessed(
    delivery: Pick<WebhookDelivery, 'provider' | 'externalId'>,
  ): Promise<void> {
    const key = InMemoryWebhookLedger.key(delivery.provider, delivery.externalId);
    const entry = this.claimed.get(key);
    if (entry === undefined) {
      return Promise.reject(new Error(`delivery was never claimed: ${key}`));
    }
    entry.processedAt = Time.nowUtc();
    return Promise.resolve();
  }

  /** Claimed but never applied — the state worth alerting on in production. */
  unprocessed(): readonly string[] {
    return [...this.claimed.entries()]
      .filter(([, entry]) => entry.processedAt === null)
      .map(([key]) => key);
  }
}

/**
 * Records what it was asked to erase, and erases nothing.
 *
 * Behavioural enough for the identity module's purposes: what matters there is
 * that erasure is attempted *before* the tombstone, and in the right order. The
 * profiles module tests what erasure actually does.
 */
export class RecordingEraser implements PersonalDataEraser {
  readonly erased: string[] = [];
  private failure: Error | null = null;

  failNextErase(error: Error): this {
    this.failure = error;
    return this;
  }

  erase(actor: Actor): Promise<void> {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }
    this.erased.push(actor.userId);
    return Promise.resolve();
  }
}

/** Returns whatever a test seeds, standing in for the profiles module. */
export class StubDataSource implements PersonalDataSource {
  private profile: ExportedProfile = null;

  returns(profile: ExportedProfile): this {
    this.profile = profile;
    return this;
  }

  exportFor(): Promise<ExportedProfile> {
    return Promise.resolve(this.profile);
  }
}

/**
 * The profiles module's administrative summary, stubbed.
 *
 * Deliberately *not* folded into `StubDataSource`. The two ports answer
 * different questions — "everything, for the person themselves" and "the least
 * that helps support" — and a double that returned one value for both would let
 * a test pass while the two projections had silently become the same thing,
 * which is the exact failure the split exists to prevent.
 */
export class StubProfileSummarySource implements ProfileSummarySource {
  private summary: AdminProfile = null;

  returns(summary: AdminProfile): this {
    this.summary = summary;
    return this;
  }

  summaryFor(): Promise<AdminProfile> {
    return Promise.resolve(this.summary);
  }
}

/**
 * Dual approval, in memory.
 *
 * **It enforces the two-person rule and the single-outcome rule**, because
 * Postgres enforces them as CHECK constraints and a double that did not would
 * let a test pass for a situation that cannot occur in it. That defect has now
 * appeared twice in this codebase — `InMemoryUserDirectory` in slice 1.7 and
 * `InMemoryAuditLog` in 1.8b-i — and here the rule being mirrored is the one
 * the whole mechanism exists for.
 */
export class InMemoryAdminApprovalStore implements AdminApprovalStore {
  private readonly rows = new Map<string, AdminApproval>();
  private nextId = 1;

  /** Everything recorded, for a test to assert against. */
  all(): readonly AdminApproval[] {
    return [...this.rows.values()];
  }

  /**
   * Overwrite a row wholesale. **Test-only, and only for ageing a proposal.**
   *
   * The approval window is a day, so a test that waited for expiry is a test
   * nobody runs. This is deliberately not on `AdminApprovalStore` — a
   * production port that could rewrite an approval would be a way round the
   * two-person rule, which is the one thing this table exists to enforce.
   */
  replace(approval: AdminApproval): this {
    this.rows.set(approval.id, approval);
    return this;
  }

  propose(input: ProposeApproval): Promise<AdminApproval> {
    const id = `00000000-0000-4000-9000-${String(this.nextId++).padStart(12, '0')}`;
    const approval: AdminApproval = {
      id,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      proposedById: input.proposedById,
      proposedReason: input.proposedReason,
      proposedAt: Time.nowUtc(),
      expiresAt: input.expiresAt,
      approvedById: null,
      approvedReason: null,
      approvedAt: null,
      cancelledById: null,
      cancelledReason: null,
      cancelledAt: null,
    };
    this.rows.set(id, approval);
    return Promise.resolve(approval);
  }

  find(id: string): Promise<AdminApproval | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listPending(now: Date, limit: number): Promise<readonly AdminApproval[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.approvedAt === null &&
            row.cancelledAt === null &&
            row.expiresAt.getTime() > now.getTime(),
        )
        .reverse()
        .slice(0, limit),
    );
  }

  approveAndApply(decision: ApprovalDecision): Promise<AdminApproval> {
    const row = this.claim(
      decision,
      (r) => r.expiresAt.getTime() > decision.at.getTime(),
    );

    // The CHECK constraint, mirrored. Without it a test could approve its own
    // proposal here and pass, while Postgres would have refused outright.
    if (row.proposedById === decision.byId) {
      return Promise.reject(new ApprovalConflictError());
    }

    const approved: AdminApproval = {
      ...row,
      approvedById: decision.byId,
      approvedReason: decision.reason,
      approvedAt: decision.at,
    };
    this.rows.set(row.id, approved);

    // The effect, applied by whoever wired this up. The real store does it in
    // the same transaction; here the caller passes an applier so a test can
    // assert the role actually changed.
    this.apply?.(approved);

    return Promise.resolve(approved);
  }

  cancel(decision: ApprovalDecision): Promise<AdminApproval> {
    const row = this.claim(decision, () => true);
    const cancelled: AdminApproval = {
      ...row,
      cancelledById: decision.byId,
      cancelledReason: decision.reason,
      cancelledAt: decision.at,
    };
    this.rows.set(row.id, cancelled);
    return Promise.resolve(cancelled);
  }

  /** Set by the test wiring, standing in for the store's transaction. */
  apply?: (approval: AdminApproval) => void;

  private claim(
    decision: ApprovalDecision,
    stillOpen: (row: AdminApproval) => boolean,
  ): AdminApproval {
    const row = this.rows.get(decision.approvalId);
    if (row === undefined) throw new ApprovalConflictError();

    // The single-outcome CHECK, mirrored: a row that already has an outcome
    // cannot take another one.
    if (row.approvedAt !== null || row.cancelledAt !== null || !stillOpen(row)) {
      throw new ApprovalConflictError();
    }

    return row;
  }
}

export interface IdentityFakes {
  readonly sessionVerifier: FakeSessionVerifier;
  readonly users: InMemoryUserDirectory;
  readonly ledger: InMemoryWebhookLedger;
  readonly service: IdentityService;
  /** Exposed so a test can assert what the module recorded. */
  readonly audit: AuditFakes;
  readonly eraser: RecordingEraser;
  readonly source: StubDataSource;
  readonly summaries: StubProfileSummarySource;
  readonly approvals: InMemoryAdminApprovalStore;
}

/**
 * A complete identity module backed by fakes, shaped to drop straight into
 * `AppModule.register`. Lets a test boot the whole application — real guard,
 * real routing — without Postgres or a Clerk instance.
 */
export function createIdentityFakes(audit = createAuditFakes()): IdentityFakes {
  const sessionVerifier = new FakeSessionVerifier();
  const users = new InMemoryUserDirectory();
  const ledger = new InMemoryWebhookLedger();
  const eraser = new RecordingEraser();
  const source = new StubDataSource();
  const summaries = new StubProfileSummarySource();
  const approvals = new InMemoryAdminApprovalStore();

  // Stands in for the transaction the real store performs. Wired here so the
  // fake's `approveAndApply` really does change the role, and a test asserting
  // that the effect happened is asserting the mechanism rather than a flag.
  approvals.apply = (approval) => {
    const target = users.all().find((row) => row.id === approval.action.userId);
    if (target !== undefined) {
      users.seed({ ...target, role: approval.action.role });
    }
  };

  return {
    sessionVerifier,
    users,
    ledger,
    audit,
    eraser,
    source,
    summaries,
    approvals,
    service: new IdentityService(
      users,
      ledger,
      audit.service,
      eraser,
      source,
      summaries,
      approvals,
    ),
  };
}
