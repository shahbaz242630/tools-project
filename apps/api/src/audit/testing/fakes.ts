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
import type { AuditEntry, AuditLog, RecordedEntry } from '../audit-log.js';
import { AuditService } from '../audit.service.js';
import { createStateDigest } from '../state-digest.js';

/** A fixed 32-byte key. Never a real one — those live in the secret manager. */
export const TEST_DIGEST_KEY = Buffer.alloc(32, 11).toString('base64');

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
          ipAddress: row.ipAddress,
          createdAt: row.createdAt,
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
