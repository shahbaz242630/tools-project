/**
 * The audit adapter against a real database.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaAuditLog } from './prisma-audit-log.js';
import type { AuditEntry } from './audit-log.js';

const env = loadEnv();

const client = createPrismaClient({
  connectionString: buildPostgresUrl({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_TEST_DB,
  }),
});

const log = new PrismaAuditLog(client);

const entry = (actorId: string | null, over: Partial<AuditEntry> = {}): AuditEntry => ({
  actorId,
  action: 'profile.updated',
  targetType: 'profile',
  targetId: randomUUID(),
  beforeHash: 'a'.repeat(64),
  afterHash: 'b'.repeat(64),
  ipAddress: '203.0.113.7',
  ...over,
});

async function newUser(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
    },
  });
  return user.id;
}

beforeEach(async () => {
  await client.auditLog.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('record', () => {
  it('appends an entry', async () => {
    const actorId = await newUser();
    await log.record(entry(actorId));

    const rows = await client.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId, action: 'profile.updated' });
  });

  it('appends rather than replacing, even for the same target', async () => {
    // The property that makes this a trail rather than a status column. Two
    // edits to one profile are two entries.
    const actorId = await newUser();
    const targetId = randomUUID();

    await log.record(entry(actorId, { targetId }));
    await log.record(entry(actorId, { targetId }));

    expect(await client.auditLog.count()).toBe(2);
  });

  it('stores a null actor and a null address', async () => {
    await log.record(entry(null, { ipAddress: null }));

    expect(await client.auditLog.findFirst()).toMatchObject({
      actorId: null,
      ipAddress: null,
    });
  });

  it('rejects an entry naming an actor that does not exist', async () => {
    await expect(log.record(entry(randomUUID()))).rejects.toThrow();
  });

  it('rejects a malformed address, because the column is inet', async () => {
    // The value arrives on a header, so it is attacker-influenced. Postgres
    // refusing it is better than storing something that is later believed.
    const actorId = await newUser();
    await expect(
      log.record(entry(actorId, { ipAddress: 'not-an-address' })),
    ).rejects.toThrow();
  });
});

describe('listForActor', () => {
  it('returns newest first', async () => {
    const actorId = await newUser();

    for (let index = 0; index < 3; index += 1) {
      await log.record(entry(actorId));
      // Postgres resolves to microseconds; without a gap the timestamps can
      // land in the same tick and the ordering assertion passes by luck.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const entries = await log.listForActor(actorId, 10);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.createdAt.getTime()).toBeGreaterThan(
      entries[2]!.createdAt.getTime(),
    );
  });

  it('returns only the actor’s own entries', async () => {
    const [alice, bob] = [await newUser(), await newUser()];
    await log.record(entry(alice));
    await log.record(entry(alice));
    await log.record(entry(bob));

    await expect(log.listForActor(bob, 10)).resolves.toHaveLength(1);
  });

  it('honours the limit', async () => {
    const actorId = await newUser();
    for (let index = 0; index < 5; index += 1) await log.record(entry(actorId));

    await expect(log.listForActor(actorId, 2)).resolves.toHaveLength(2);
  });

  it('never selects the digests', async () => {
    // Asserted against the real query rather than the mapping, so a `select`
    // widened later is caught here and not in an HTTP response.
    const actorId = await newUser();
    await log.record(entry(actorId));

    const [read] = await log.listForActor(actorId, 10);
    expect(Object.keys(read!).sort()).toEqual([
      'action',
      'createdAt',
      'id',
      'ipAddress',
      'targetType',
    ]);
  });

  it('is empty for an actor with no entries', async () => {
    await expect(log.listForActor(await newUser(), 10)).resolves.toEqual([]);
  });
});

describe('immutability', () => {
  it('offers no way to change or remove an entry', () => {
    // Append-only is enforced by what this port does not have. Prisma would
    // generate an update or a delete against this table happily; the guarantee
    // is that no code exists to call one. If either name appears here, that
    // decision is being reversed (ADR 0017).
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(log)).sort()).toEqual([
      'constructor',
      'listForActor',
      'record',
    ]);
  });

  it('keeps the entry when its actor is hard-deleted', async () => {
    // ON DELETE SET NULL. Accounts are soft-deleted so this should never fire,
    // but if it does, losing the actor beats losing the record: §10.1 retains
    // security logs six years, and the event is the obligation.
    const actorId = await newUser();
    await log.record(entry(actorId));

    await client.user.delete({ where: { id: actorId } });

    const rows = await client.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBeNull();
  });
});
