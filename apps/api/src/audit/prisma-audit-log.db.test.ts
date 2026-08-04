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
  sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
  reason: null,
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
  await client.adminApproval.deleteMany();
  // authentication_events is ON DELETE RESTRICT, added in slice 1.11a.
  // Children before parents, in every file — not only the new one.
  await client.authenticationEvent.deleteMany();
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

  it('stores the session the action happened in', async () => {
    // The join key to `authentication_events`. Asserted against the column
    // rather than through `listForActor`, so a mapping that dropped it on the
    // way in would still fail here.
    const actorId = await newUser();
    await log.record(entry(actorId, { sessionId: 'sess_2mXqL9zPqR4tVn' }));

    expect(await client.auditLog.findFirst()).toMatchObject({
      clerkSessionId: 'sess_2mXqL9zPqR4tVn',
    });
  });

  it('stores a null session for an action nothing was signed in for', async () => {
    // A provider webhook applying a change with nobody holding a session. The
    // honest value, and the one every row predating this column carries.
    const actorId = await newUser();
    await log.record(entry(actorId, { sessionId: null }));

    expect(await client.auditLog.findFirst()).toMatchObject({
      clerkSessionId: null,
    });
  });

  it('accepts a session id that is not a uuid', async () => {
    // Clerk mints prefixed strings, not UUIDs, which is why the column is text.
    // Pinned because `actorId` and `targetId` beside it *are* uuid columns, and
    // a well-meaning migration that "tidied" this one would break every write.
    const actorId = await newUser();

    await expect(
      log.record(entry(actorId, { sessionId: 'sess_not_a_uuid_at_all' })),
    ).resolves.toBeUndefined();
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

  it('rejects a malformed target id, because the column is uuid', async () => {
    // The behaviour `InMemoryAuditLog` now mirrors. `targetId` reaches this
    // from a path parameter on the admin route, and because audit writes are
    // fail-closed, a throw here is a 500 on the action being recorded. A double
    // that accepted any string let that pass every test.
    const actorId = await newUser();
    await expect(log.record(entry(actorId, { targetId: 'banana' }))).rejects.toThrow();
  });
});

describe('listForSubject', () => {
  it('returns what somebody else did to this account', async () => {
    const [alice, admin] = [await newUser(), await newUser()];

    await log.record(
      entry(admin, {
        action: 'admin.activity_viewed',
        targetType: 'user',
        targetId: alice,
        reason: 'ticket 4821',
      }),
    );

    const entries = await log.listForSubject(alice, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'admin.activity_viewed',
      reason: 'ticket 4821',
      byAnotherUser: true,
    });
  });

  it('returns an entry with no actor at all', async () => {
    // The case an inequality alone would silently drop: SQL `<>` does not match
    // NULL, so `NOT (actorId = alice)` excludes exactly the webhook-applied
    // rows — which had reached no trail at all before this query existed.
    const alice = await newUser();

    await log.record(
      entry(null, {
        action: 'account.email_changed',
        targetType: 'user',
        targetId: alice,
      }),
    );

    const entries = await log.listForSubject(alice, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.byAnotherUser).toBe(false);
  });

  it('excludes what the account did to itself', async () => {
    // `account.provisioned` names the account as both actor and target, so
    // without this the merged trail would show it twice.
    const alice = await newUser();

    await log.record(
      entry(alice, {
        action: 'account.provisioned',
        targetType: 'user',
        targetId: alice,
      }),
    );

    await expect(log.listForSubject(alice, 10)).resolves.toEqual([]);
  });

  it('never selects the address, the session or the digests', async () => {
    // Asserted against the real query, not the mapping, and as an exhaustive
    // key set rather than a list of absences — so a column added to this
    // `select` later fails here whether or not anybody thought about it.
    //
    // The address and the session on these rows are the *administrator's*.
    // Either one in front of the person they looked at is a disclosure, and the
    // session is the subtler of the two: several disclosures sharing one id tell
    // the subject when a particular support worker was at their desk.
    const [alice, admin] = [await newUser(), await newUser()];
    await log.record(
      entry(admin, {
        targetType: 'user',
        targetId: alice,
        sessionId: 'sess_admin_should_not_leak',
      }),
    );

    const [read] = await log.listForSubject(alice, 10);
    expect(Object.keys(read!).sort()).toEqual([
      'action',
      'byAnotherUser',
      'createdAt',
      'id',
      'reason',
      'targetType',
    ]);
  });

  it('returns newest first', async () => {
    const [alice, admin] = [await newUser(), await newUser()];

    for (let index = 0; index < 3; index += 1) {
      await log.record(entry(admin, { targetType: 'user', targetId: alice }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const entries = await log.listForSubject(alice, 10);
    expect(entries[0]!.createdAt.getTime()).toBeGreaterThan(
      entries[2]!.createdAt.getTime(),
    );
  });

  it('honours the limit', async () => {
    const [alice, admin] = [await newUser(), await newUser()];
    for (let index = 0; index < 5; index += 1) {
      await log.record(entry(admin, { targetType: 'user', targetId: alice }));
    }

    await expect(log.listForSubject(alice, 2)).resolves.toHaveLength(2);
  });

  it('is empty for an account nobody has touched', async () => {
    await expect(log.listForSubject(await newUser(), 10)).resolves.toEqual([]);
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
      // Served deliberately: being able to read *why* an administrator looked
      // at your account is most of the point of recording it. The digests are
      // still absent, which is what this test is really guarding.
      'reason',
      // Also deliberate, and only on *this* query. These are the reader's own
      // actions, so it is their own session — `listForSubject` omits it,
      // because there it would be the administrator's.
      'sessionId',
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
      'listForSubject',
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
