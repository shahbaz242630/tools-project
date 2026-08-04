/**
 * Authentication events against a real database.
 *
 * The in-memory double models these rules; only Postgres enforces them, and
 * that gap is exactly where this project has repeatedly found bugs. Three of
 * the four rules below could not be tested any other way: the `inet` column's
 * rejection of a malformed address, the unique index that makes a redelivery a
 * no-op, and the `event_is_known` CHECK.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { Time } from '@platform/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_SESSION_ACTIVITY } from './authentication-events.js';
import { PrismaAuthenticationEvents } from './prisma-authentication-events.js';

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

const store = new PrismaAuthenticationEvents(client);

const uniqueSessionId = () => `sess_${randomUUID()}`;

/** The activity from a real Clerk delivery, IPv6 and all. */
const ACTIVITY = {
  ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
  browserName: 'Edge',
  browserVersion: '150.0.0.0',
  deviceType: 'Windows',
  isMobile: false,
};

async function makeUser(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
    },
  });
  return user.id;
}

beforeEach(async () => {
  // Children before parents. This table is itself a child of `users`, so it
  // goes before the parent delete and after nothing.
  await client.authenticationEvent.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  // category_versions is ON DELETE RESTRICT against users, added in slice 2.1.
  // Children before parents, in every file -- not only the new one.
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  // seller_tax_profiles is ON DELETE RESTRICT against users (slice 2.3).
  // Children before parents, in every file — a new foreign key means editing
  // all of them, not only the one the slice was about.
  await client.sellerTaxProfile.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('PrismaAuthenticationEvents', () => {
  it('stores a sign-in with its device and place', async () => {
    const userId = await makeUser();
    const clerkSessionId = uniqueSessionId();

    await store.record({
      userId,
      clerkSessionId,
      event: 'started',
      occurredAt: Time.fromIsoUtc('2026-07-30T10:53:19.422Z'),
      activity: ACTIVITY,
    });

    const [row] = await store.listFor(userId, 10);
    expect(row).toMatchObject({
      clerkSessionId,
      event: 'started',
      occurredAt: Time.fromIsoUtc('2026-07-30T10:53:19.422Z'),
      activity: ACTIVITY,
    });
  });

  it('round-trips an IPv6 address without truncating it', async () => {
    // Real values from Clerk are frequently IPv6. `inet` holds them; a
    // varchar(15) chosen for dotted quads would have silently cut this in half.
    const userId = await makeUser();
    await store.record({
      userId,
      clerkSessionId: uniqueSessionId(),
      event: 'started',
      occurredAt: Time.nowUtc(),
      activity: ACTIVITY,
    });

    const [row] = await store.listFor(userId, 10);
    expect(row?.activity.ipAddress).toBe('2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e');
  });

  it('stores an event carrying no activity at all', async () => {
    const userId = await makeUser();
    await store.record({
      userId,
      clerkSessionId: uniqueSessionId(),
      event: 'started',
      occurredAt: Time.nowUtc(),
      activity: NO_SESSION_ACTIVITY,
    });

    const [row] = await store.listFor(userId, 10);
    expect(row?.activity).toEqual(NO_SESSION_ACTIVITY);
  });

  it('records a malformed address as null instead of throwing', async () => {
    // The 1.5a bug class. Fastify joins a repeated header into `"a,b"`, `inet`
    // refuses that string, and this write is on the webhook path — so an
    // unvalidated value would become a delivery Clerk retries forever. Proven
    // against the real column rather than against `validIpOrNull` alone.
    const userId = await makeUser();
    await store.record({
      userId,
      clerkSessionId: uniqueSessionId(),
      event: 'started',
      occurredAt: Time.nowUtc(),
      activity: { ...ACTIVITY, ipAddress: '1.2.3.4,5.6.7.8' },
    });

    const [row] = await store.listFor(userId, 10);
    expect(row?.activity.ipAddress).toBeNull();
    // The rest of the row survived — a bad address must not lose the event.
    expect(row?.activity.deviceType).toBe('Windows');
  });

  it('is idempotent for the same session and event', async () => {
    const userId = await makeUser();
    const clerkSessionId = uniqueSessionId();
    const event = {
      userId,
      clerkSessionId,
      event: 'started' as const,
      occurredAt: Time.fromIsoUtc('2026-07-30T10:53:19.422Z'),
      activity: ACTIVITY,
    };

    await store.record(event);
    await store.record(event);

    expect(await store.listFor(userId, 10)).toHaveLength(1);
  });

  it('does not let a replay overwrite what was recorded first', async () => {
    // `update: {}` in the upsert. The first record is the one that was true at
    // the time; a redelivery carrying later data must not rewrite a security
    // record silently.
    const userId = await makeUser();
    const clerkSessionId = uniqueSessionId();

    await store.record({
      userId,
      clerkSessionId,
      event: 'started',
      occurredAt: Time.nowUtc(),
      activity: ACTIVITY,
    });
    await store.record({
      userId,
      clerkSessionId,
      event: 'started',
      occurredAt: Time.nowUtc(),
      activity: { ...ACTIVITY, deviceType: 'Android' },
    });

    const [row] = await store.listFor(userId, 10);
    expect(row?.activity.deviceType).toBe('Windows');
  });

  it('keeps a sign-in and a sign-out for the same session', async () => {
    const userId = await makeUser();
    const clerkSessionId = uniqueSessionId();

    await store.record({
      userId,
      clerkSessionId,
      event: 'started',
      occurredAt: Time.fromIsoUtc('2026-07-30T10:00:00.000Z'),
      activity: ACTIVITY,
    });
    await store.record({
      userId,
      clerkSessionId,
      event: 'ended',
      occurredAt: Time.fromIsoUtc('2026-07-30T18:00:00.000Z'),
      activity: ACTIVITY,
    });

    // Newest first.
    expect((await store.listFor(userId, 10)).map((row) => row.event)).toEqual([
      'ended',
      'started',
    ]);
  });

  it('refuses an event value outside the four', async () => {
    // The CHECK constraint. A rule living only in the mapper is one the next
    // code path forgets, and the cost of forgetting is a row the activity page
    // cannot label (ADR 0004's reasoning).
    const userId = await makeUser();

    await expect(
      store.record({
        userId,
        clerkSessionId: uniqueSessionId(),
        // Cast, because the type system is the *other* guard and this test is
        // about what happens when something gets past it.
        event: 'banana' as 'started',
        occurredAt: Time.nowUtc(),
        activity: NO_SESSION_ACTIVITY,
      }),
    ).rejects.toThrow(/event_is_known/);
  });

  it('serves only the account asked for', async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    await store.record({
      userId: bob,
      clerkSessionId: uniqueSessionId(),
      event: 'started',
      occurredAt: Time.nowUtc(),
      activity: ACTIVITY,
    });

    expect(await store.listFor(alice, 10)).toEqual([]);
  });

  it('honours the limit', async () => {
    const userId = await makeUser();
    for (let index = 0; index < 3; index++) {
      await store.record({
        userId,
        clerkSessionId: uniqueSessionId(),
        event: 'started',
        occurredAt: Time.fromIsoUtc(`2026-07-1${String(index)}T10:00:00.000Z`),
        activity: ACTIVITY,
      });
    }

    expect(await store.listFor(userId, 2)).toHaveLength(2);
  });

  describe('eraseActivity', () => {
    it('nulls the personal columns and keeps the row', async () => {
      const userId = await makeUser();
      const clerkSessionId = uniqueSessionId();
      await store.record({
        userId,
        clerkSessionId,
        event: 'started',
        occurredAt: Time.fromIsoUtc('2026-07-30T10:53:19.422Z'),
        activity: ACTIVITY,
      });

      await store.eraseActivity(userId);

      const [row] = await store.listFor(userId, 10);
      expect(row).toMatchObject({
        clerkSessionId,
        event: 'started',
        occurredAt: Time.fromIsoUtc('2026-07-30T10:53:19.422Z'),
        activity: NO_SESSION_ACTIVITY,
      });
    });

    it('leaves no trace of the address in the column itself', async () => {
      // Asserted against the raw row rather than through `listFor`, because a
      // mapping that dropped the field would make the read look erased while
      // the value sat in the table. Same reasoning as asserting a leak against
      // a raw response body rather than a parsed object.
      const userId = await makeUser();
      await store.record({
        userId,
        clerkSessionId: uniqueSessionId(),
        event: 'started',
        occurredAt: Time.nowUtc(),
        activity: ACTIVITY,
      });

      await store.eraseActivity(userId);

      const raw = await client.authenticationEvent.findFirst({ where: { userId } });
      expect(raw).not.toBeNull();
      expect(raw?.ipAddress).toBeNull();
      expect(raw?.browserName).toBeNull();
      expect(raw?.deviceType).toBeNull();
    });

    it('is idempotent', async () => {
      const userId = await makeUser();
      await store.record({
        userId,
        clerkSessionId: uniqueSessionId(),
        event: 'started',
        occurredAt: Time.nowUtc(),
        activity: ACTIVITY,
      });

      await store.eraseActivity(userId);
      await store.eraseActivity(userId);

      expect(await store.listFor(userId, 10)).toHaveLength(1);
    });

    it('succeeds for an account that never signed in', async () => {
      // A retry after a partial failure has to be able to finish, and erasing
      // nothing is a success.
      await expect(store.eraseActivity(await makeUser())).resolves.toBeUndefined();
    });

    it('leaves the row erasable rather than blocking the parent delete', async () => {
      // The RESTRICT foreign key. Deletion is soft in production so this cannot
      // fire there, but the constraint is real and worth pinning: erasure must
      // not be the thing that makes an account unremovable.
      const userId = await makeUser();
      await store.record({
        userId,
        clerkSessionId: uniqueSessionId(),
        event: 'started',
        occurredAt: Time.nowUtc(),
        activity: ACTIVITY,
      });
      await store.eraseActivity(userId);

      await expect(client.user.delete({ where: { id: userId } })).rejects.toThrow();

      // And with the children gone first, it succeeds — which is what the
      // beforeEach in every other db test file now has to do.
      await client.authenticationEvent.deleteMany({ where: { userId } });
      await expect(
        client.user.delete({ where: { id: userId } }),
      ).resolves.toMatchObject({ id: userId });
    });
  });
});
