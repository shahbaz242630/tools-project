/**
 * The feature-flag adapter against a real database.
 *
 * Needs `pnpm db:up` and migrations applied to the test database.
 *
 * The tests worth having here are the ones a double cannot fake: that the
 * unique constraint on `key` really makes a second switch an update rather than
 * a second row, that the foreign key really holds an author in place, and that
 * `updatedAt` really moves when a flag is switched — the column the admin page's
 * "when did this change" comes from.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaFeatureFlagStore } from './prisma-flag-store.js';

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

const store = new PrismaFeatureFlagStore(client);

const FLAG = 'listing.publication';

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
  await client.featureFlagOverride.deleteMany();
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  await client.sellerTaxProfile.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  await client.authenticationEvent.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('switching a flag', () => {
  it('writes the row and reads it back', async () => {
    const admin = await newUser();

    const written = await store.set(FLAG, false, admin);

    expect(written).toMatchObject({ key: FLAG, enabled: false, changedById: admin });
    expect(await store.listOverrides()).toMatchObject([{ key: FLAG, enabled: false }]);
  });

  it('replaces rather than duplicating, keeping one row and one identity', async () => {
    // The property the unique constraint on `key` exists for. Two rows for one
    // flag would be two answers to a question that must have one, and the
    // evaluator would have to pick between them.
    const first = await newUser();
    const second = await newUser();

    const before = await store.set(FLAG, false, first);
    const after = await store.set(FLAG, true, second);

    expect(await store.listOverrides()).toHaveLength(1);
    expect(after.enabled).toBe(true);
    expect(after.changedById).toBe(second);
    // The same row, so an audit entry written against it earlier still points at
    // the thing that changed.
    expect(after.id).toBe(before.id);
  });

  it('moves `changedAt` when the flag is switched again', async () => {
    // The column the admin page's "when did this change" comes from, and it is
    // Prisma's `@updatedAt` rather than anything this code writes — so it is
    // worth proving it actually moves rather than assuming the decorator works.
    const admin = await newUser();
    const before = await store.set(FLAG, false, admin);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await store.set(FLAG, true, admin);

    expect(after.changedAt.getTime()).toBeGreaterThan(before.changedAt.getTime());
  });

  it('returns overrides sorted by key', async () => {
    // Matching the fake, so an assertion about ordering cannot pass in one and
    // fail in the other.
    const admin = await newUser();
    await store.set(FLAG, false, admin);
    // A key this build no longer declares, written directly: the store holds
    // rows and does not know the vocabulary — the *service* is what ignores it.
    await client.featureFlagOverride.create({
      data: { key: 'a.retired_flag', enabled: true, changedById: admin },
    });

    expect((await store.listOverrides()).map((row) => row.key)).toEqual([
      'a.retired_flag',
      FLAG,
    ]);
  });
});

describe('the constraints', () => {
  it('will not let an author be deleted out from under an override', async () => {
    // ON DELETE RESTRICT. Accounts are soft-deleted so this never fires in
    // practice, but an override that vanished with its author would leave the
    // platform in a state nobody appeared to have chosen.
    const admin = await newUser();
    await store.set(FLAG, false, admin);

    await expect(client.user.delete({ where: { id: admin } })).rejects.toThrow();
  });

  it('refuses a second row for the same key, in the database', async () => {
    // The guarantee held where it cannot be bypassed by code. `set` upserts, so
    // this is the only way to watch the constraint actually fire.
    const admin = await newUser();
    await store.set(FLAG, false, admin);

    await expect(
      client.featureFlagOverride.create({
        data: { key: FLAG, enabled: true, changedById: admin },
      }),
    ).rejects.toThrow();
  });
});
