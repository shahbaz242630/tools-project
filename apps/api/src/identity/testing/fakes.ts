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

/** Accepts exactly the tokens it was given, rejects everything else. */
export class FakeSessionVerifier implements SessionVerifier {
  private readonly sessions = new Map<string, VerifiedSession>();

  accept(token: string, session: VerifiedSession): this {
    this.sessions.set(token, session);
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

export interface IdentityFakes {
  readonly sessionVerifier: FakeSessionVerifier;
  readonly users: InMemoryUserDirectory;
  readonly ledger: InMemoryWebhookLedger;
  readonly service: IdentityService;
  /** Exposed so a test can assert what the module recorded. */
  readonly audit: AuditFakes;
  readonly eraser: RecordingEraser;
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
  return {
    sessionVerifier,
    users,
    ledger,
    audit,
    eraser,
    service: new IdentityService(users, ledger, audit.service, eraser),
  };
}
