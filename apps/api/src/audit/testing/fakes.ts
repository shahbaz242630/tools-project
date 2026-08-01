/**
 * Test doubles for the audit module.
 *
 * Behavioural rather than recording spies, the same rule the identity and
 * profiles fakes follow — with one deliberate exception: this double *is*
 * mostly a recorder, because an audit log's whole behaviour is "keeps what it
 * was given, in order, and never changes it". `entries()` exposes that so a
 * test can assert what was recorded, which is the point.
 *
 * It enforces append-only the same way the real one does: there is no method
 * here that edits or removes an entry.
 */

import { Time } from '@platform/core';
import type {
  AuditEntry,
  AuditLog,
  DisclosedEntry,
  RecordedEntry,
} from '../audit-log.js';
import { AuditService } from '../audit.service.js';
import { createStateDigest } from '../state-digest.js';

/** A fixed 32-byte key. Never a real one — those live in the secret manager. */
export const TEST_DIGEST_KEY = Buffer.alloc(32, 11).toString('base64');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Raised for an id Postgres would reject.
 *
 * `actorId` and `targetId` are `uuid` columns, so the real store throws on a
 * malformed value — and because audit writes are fail-closed, that throw takes
 * down the action being audited. A double that accepted any string let a test
 * pass for a situation that could not occur in it, which is exactly the defect
 * this file's header warns about and which cost an hour in slice 1.7.
 */
export class InvalidAuditIdError extends Error {
  constructor(field: string, value: string) {
    super(`${field} must be a uuid, got ${JSON.stringify(value)}`);
    this.name = 'InvalidAuditIdError';
  }
}

export class InMemoryAuditLog implements AuditLog {
  private readonly rows: (AuditEntry & { id: string; createdAt: Date })[] = [];
  private nextId = 1;

  /** Fails the next write, to exercise the fail-closed paths above. */
  private failure: Error | null = null;

  failNextRecord(error: Error): this {
    this.failure = error;
    return this;
  }

  /** Everything recorded, oldest first — insertion order. */
  entries(): readonly AuditEntry[] {
    return [...this.rows];
  }

  record(entry: AuditEntry): Promise<void> {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }

    // Enforced here because Postgres enforces it there. Both columns are
    // `uuid`; a caller that passes a path parameter straight through gets a
    // 500 in production and a green test without this.
    if (entry.actorId !== null && !UUID.test(entry.actorId)) {
      return Promise.reject(new InvalidAuditIdError('actorId', entry.actorId));
    }
    if (!UUID.test(entry.targetId)) {
      return Promise.reject(new InvalidAuditIdError('targetId', entry.targetId));
    }

    this.rows.push({
      ...entry,
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`,
      createdAt: Time.nowUtc(),
    });

    return Promise.resolve();
  }

  listForActor(actorId: string, limit: number): Promise<readonly RecordedEntry[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.actorId === actorId)
        // Reverse insertion order, not a timestamp comparison. Several entries
        // recorded in the same millisecond — which is normal in a test — would
        // sort arbitrarily by clock, and "newest first" is the one ordering
        // guarantee this port makes. The real store sorts in Postgres, where
        // the resolution is microseconds.
        .reverse()
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          action: row.action,
          targetType: row.targetType,
          reason: row.reason,
          ipAddress: row.ipAddress,
          createdAt: row.createdAt,
        })),
    );
  }

  listForSubject(subjectId: string, limit: number): Promise<readonly DisclosedEntry[]> {
    return Promise.resolve(
      this.rows
        // Somebody else's action on this account, or nobody's. The null-actor
        // case is a provider webhook, and it matters: those entries reached no
        // trail at all before this query existed.
        .filter((row) => row.targetId === subjectId && row.actorId !== subjectId)
        .reverse()
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          action: row.action,
          targetType: row.targetType,
          reason: row.reason,
          createdAt: row.createdAt,
          byAnotherUser: row.actorId !== null,
          // No `ipAddress`, matching the real store — the type has no such
          // field, so a double that carried one would not compile.
        })),
    );
  }
}

export interface AuditFakes {
  readonly log: InMemoryAuditLog;
  readonly service: AuditService;
}

export function createAuditFakes(): AuditFakes {
  const log = new InMemoryAuditLog();
  return { log, service: new AuditService(log, createStateDigest(TEST_DIGEST_KEY)) };
}
