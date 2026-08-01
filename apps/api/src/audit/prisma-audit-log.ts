import type { PrismaClient } from '@platform/database';
import type {
  AuditAction,
  AuditEntry,
  AuditLog,
  DisclosedEntry,
  RecordedEntry,
} from './audit-log.js';

/**
 * Postgres-backed audit trail.
 *
 * Uses `create` and `findMany` and nothing else. There is no `update` and no
 * `delete` anywhere in this file, and that is the whole implementation of
 * "immutable": Prisma will happily generate either against this table, so the
 * guarantee lives in the code that is allowed to exist rather than in a
 * database permission we do not yet have a role to grant.
 *
 * When a dedicated application role arrives with the VPS, revoking UPDATE and
 * DELETE on `audit_logs` is the belt to this braces. Until then this is the
 * enforcement, which is why the port above it offers no such method to call.
 */
export class PrismaAuditLog implements AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
        ipAddress: entry.ipAddress,
        reason: entry.reason,
      },
    });
  }

  async listForActor(
    actorId: string,
    limit: number,
  ): Promise<readonly RecordedEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: limit,

      // Explicit, rather than returning the row. The digests are not useful to
      // the person reading their own activity and are not theirs to reason
      // about; selecting them here would put them in an HTTP response for no
      // purpose. A `select` also means a column added later is not served the
      // day it appears.
      select: {
        id: true,
        action: true,
        targetType: true,
        reason: true,
        ipAddress: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      // The column is text so any string could be stored; the write path only
      // ever supplies an `AuditAction`. Narrowed rather than asserted blindly
      // so the one place that trusts the database is visible.
      action: row.action as AuditAction,
      targetType: row.targetType,
      reason: row.reason,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt,
    }));
  }

  async listForSubject(
    subjectId: string,
    limit: number,
  ): Promise<readonly DisclosedEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        targetId: subjectId,

        // "Somebody other than me, or nobody at all." Spelled as an explicit
        // OR rather than `NOT: { actorId: subjectId }`, because SQL inequality
        // does not match NULL — and the null-actor rows are exactly the ones
        // worth keeping. A provider webhook applies an email change with no
        // session behind it, and until now that reached nobody's trail at all.
        OR: [{ actorId: null }, { actorId: { not: subjectId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,

      // `actorId` is selected but never served — it decides `byAnotherUser` and
      // is dropped in the same expression. `ipAddress` is not selected at all:
      // on these rows it is the administrator's address, and a column that is
      // never read cannot be leaked by a later change to the mapping below.
      select: {
        id: true,
        action: true,
        targetType: true,
        reason: true,
        createdAt: true,
        actorId: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action as AuditAction,
      targetType: row.targetType,
      reason: row.reason,
      createdAt: row.createdAt,
      byAnotherUser: row.actorId !== null,
    }));
  }
}
