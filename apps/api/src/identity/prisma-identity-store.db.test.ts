/**
 * The identity stores against a real database.
 *
 * The in-memory fakes model these rules; only Postgres enforces them. That
 * difference is the whole point — `upsert` and `claim` are written the way they
 * are *because* a unique constraint fires, and a test against a double proves
 * only that the double agrees with the code.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaUserDirectory, PrismaWebhookLedger } from './prisma-identity-store.js';
import { UserConflictError } from './user-directory.js';

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

const users = new PrismaUserDirectory(client);
const ledger = new PrismaWebhookLedger(client);

// randomUUID rather than a timestamp and a counter: those collide between test
// files that start in the same millisecond, and the resulting unique-constraint
// violation looks exactly like the bug these tests exist to detect.
const uniqueEmail = () => `user-${randomUUID()}@example.invalid`;
const uniqueClerkId = () => `user_${randomUUID()}`;
const uniqueDeliveryId = () => `msg_${randomUUID()}`;

beforeEach(async () => {
  // Children before parents: the profile foreign keys are ON DELETE RESTRICT,
  // so clearing `users` first throws rather than cascading.
  await client.profile.deleteMany();
  await client.address.deleteMany();
  await client.user.deleteMany();
  await client.webhookEvent.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('PrismaUserDirectory', () => {
  it('creates a mirror row', async () => {
    const clerkUserId = uniqueClerkId();
    const email = uniqueEmail();

    const user = await users.upsert({ clerkUserId, email });

    expect(user).toMatchObject({ clerkUserId, email, role: 'USER', deletedAt: null });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the existing row rather than creating a second', async () => {
    const clerkUserId = uniqueClerkId();
    const first = await users.upsert({ clerkUserId, email: uniqueEmail() });
    const second = await users.upsert({ clerkUserId, email: uniqueEmail() });

    expect(second.id).toBe(first.id);
    expect(await client.user.count()).toBe(1);
  });

  it('keeps the stored address when a repeat upsert carries a different one', async () => {
    // `upsert` provisions; it does not reconcile. Changing the address is the
    // service's decision, made after comparing — otherwise a stale replayed
    // webhook would overwrite a newer address on its way past.
    const clerkUserId = uniqueClerkId();
    const original = uniqueEmail();
    await users.upsert({ clerkUserId, email: original });

    const again = await users.upsert({ clerkUserId, email: uniqueEmail() });
    expect(again.email).toBe(original);
  });

  it('refuses to attach one address to two Clerk accounts', async () => {
    // Not an overwrite. `prisma.user.upsert` against a single conflict target
    // would silently repoint an existing row, and from Phase 2 that hands one
    // person another's listings and bookings.
    const email = uniqueEmail();
    await users.upsert({ clerkUserId: uniqueClerkId(), email });

    await expect(
      users.upsert({ clerkUserId: uniqueClerkId(), email }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });

  it('treats a differently-cased address as the same one', async () => {
    // The column is citext, so this is the database's answer rather than the
    // application's — which is what makes it hold under concurrency.
    const email = uniqueEmail();
    await users.upsert({ clerkUserId: uniqueClerkId(), email });

    await expect(
      users.upsert({ clerkUserId: uniqueClerkId(), email: email.toUpperCase() }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });

  it('finds nothing for an unknown Clerk id', async () => {
    expect(await users.findByClerkUserId('user_nobody')).toBeNull();
  });

  it('tombstoning frees the real address for re-registration', async () => {
    // The end-to-end version of the deletion rule: a retained unique row would
    // lock that person out of the platform permanently.
    const email = uniqueEmail();
    const original = await users.upsert({ clerkUserId: uniqueClerkId(), email });

    await users.update(original.id, {
      deletedAt: new Date(),
      email: `deleted+${original.id}@deleted.invalid`,
    });

    const returning = await users.upsert({ clerkUserId: uniqueClerkId(), email });
    expect(returning.id).not.toBe(original.id);
    expect(returning.email).toBe(email);
  });

  it('reads the role back as one of the two values', async () => {
    const user = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email: uniqueEmail(),
    });
    await client.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });

    expect((await users.findByClerkUserId(user.clerkUserId))?.role).toBe('ADMIN');
  });
});

describe('PrismaWebhookLedger', () => {
  const delivery = (externalId: string) => ({
    provider: 'clerk',
    externalId,
    eventType: 'user.created',
  });

  it('claims a delivery once', async () => {
    const id = uniqueDeliveryId();
    expect(await ledger.claim(delivery(id))).toBe(true);
  });

  it('refuses a second claim on the same delivery', async () => {
    const id = uniqueDeliveryId();
    await ledger.claim(delivery(id));

    // The unique constraint firing is the duplicate check. This is the
    // assertion that would fail if someone rewrote `claim` as a read then a
    // write, which passes in a single-container test and loses under two.
    expect(await ledger.claim(delivery(id))).toBe(false);
    expect(await client.webhookEvent.count()).toBe(1);
  });

  it('claims the same delivery id from a different provider', async () => {
    const id = uniqueDeliveryId();
    await ledger.claim(delivery(id));

    expect(await ledger.claim({ ...delivery(id), provider: 'stripe' })).toBe(true);
  });

  it('marks a claimed delivery processed', async () => {
    const id = uniqueDeliveryId();
    await ledger.claim(delivery(id));
    await ledger.markProcessed({ provider: 'clerk', externalId: id });

    const row = await client.webhookEvent.findFirst({
      where: { provider: 'clerk', externalId: id },
    });
    expect(row?.processedAt).toBeInstanceOf(Date);
  });

  it('leaves an unapplied delivery visibly unprocessed', async () => {
    const id = uniqueDeliveryId();
    await ledger.claim(delivery(id));

    const row = await client.webhookEvent.findFirst({
      where: { provider: 'clerk', externalId: id },
    });
    expect(row?.processedAt).toBeNull();
  });
});
