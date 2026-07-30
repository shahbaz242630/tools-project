import { Time } from '@platform/core';
import type { PrismaClient } from '@platform/database';
import { UserConflictError } from './user-directory.js';
import type {
  MirroredUser,
  UpsertUserInput,
  UserChanges,
  UserDirectory,
  UserRole,
} from './user-directory.js';
import type { WebhookDelivery, WebhookLedger } from './webhook-ledger.js';

/**
 * Postgres-backed implementations of the two identity ports.
 *
 * Prisma is our own persistence layer rather than a third-party provider, so it
 * is imported here directly — the BRD §5 adapter rule exists to keep vendor
 * SDKs replaceable, and the database is not a vendor we are hedging against.
 */

/**
 * Prisma reports a unique-constraint violation as `P2002`.
 *
 * Matched structurally rather than by importing `PrismaClientKnownRequestError`.
 * The generated client is emitted as TypeScript into a gitignored directory
 * (ADR 0014) and its error classes are not part of the stable surface; a
 * property check survives a regeneration that an `instanceof` does not.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

interface UserRow {
  id: string;
  clerkUserId: string;
  email: string;
  role: string;
  deletedAt: Date | null;
}

function toMirroredUser(row: UserRow): MirroredUser {
  return {
    id: row.id,
    clerkUserId: row.clerkUserId,
    email: row.email,
    // The column is a Postgres enum, so anything outside the two values cannot
    // be stored. Narrowed rather than asserted so the cast is visible.
    role: row.role === 'ADMIN' ? 'ADMIN' : ('USER' satisfies UserRole),
    deletedAt: row.deletedAt,
  };
}

export class PrismaUserDirectory implements UserDirectory {
  constructor(private readonly prisma: PrismaClient) {}

  async findByClerkUserId(clerkUserId: string): Promise<MirroredUser | null> {
    const row = await this.prisma.user.findUnique({ where: { clerkUserId } });
    return row === null ? null : toMirroredUser(row);
  }

  /**
   * Read, then insert, then re-read on conflict.
   *
   * Not `prisma.user.upsert`: that generates `INSERT … ON CONFLICT` against a
   * single conflict target, and this table has two independent unique
   * constraints. A second Clerk account whose email already belongs to a
   * different mirror row must be a *failure*, not an overwrite that silently
   * repoints an existing account — with foreign keys arriving in Phase 2 that
   * would hand one person another's listings and bookings.
   */
  async upsert(input: UpsertUserInput): Promise<MirroredUser> {
    const existing = await this.findByClerkUserId(input.clerkUserId);
    if (existing !== null) return existing;

    try {
      const row = await this.prisma.user.create({
        data: { clerkUserId: input.clerkUserId, email: input.email },
      });
      return toMirroredUser(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Lost a race on `clerkUserId`: the row now exists and re-reading is
      // correct. Lost it on `email` instead: two Clerk accounts claim one
      // address, the re-read finds nothing, and the conflict surfaces rather
      // than being papered over.
      const raced = await this.findByClerkUserId(input.clerkUserId);
      if (raced !== null) return raced;

      throw new UserConflictError(error);
    }
  }

  async update(id: string, changes: UserChanges): Promise<MirroredUser> {
    const row = await this.prisma.user.update({ where: { id }, data: changes });
    return toMirroredUser(row);
  }
}

export class PrismaWebhookLedger implements WebhookLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(delivery: WebhookDelivery): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: delivery.provider,
          externalId: delivery.externalId,
          eventType: delivery.eventType,
        },
      });
      return true;
    } catch (error) {
      // The unique constraint firing *is* the duplicate check. Any other
      // failure is a real error and must not read as "already handled", which
      // would silently drop the delivery.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async markProcessed(
    delivery: Pick<WebhookDelivery, 'provider' | 'externalId'>,
  ): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: {
        provider_externalId: {
          provider: delivery.provider,
          externalId: delivery.externalId,
        },
      },
      data: { processedAt: Time.nowUtc() },
    });
  }
}
