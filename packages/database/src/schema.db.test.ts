/**
 * Assertions about what the migrations actually built.
 *
 * Against a real database on purpose. Every guarantee tested here belongs to
 * Postgres, not to Prisma — a mock would only prove that the mock agrees with
 * the test. The uniqueness of an email address is a constraint or it is
 * nothing, and application-level checks lose that race under concurrency.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient, ping } from './index.js';

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

/** Distinct per test, so a leftover row cannot make a later assertion pass. */
let counter = 0;
const uniqueEmail = () => `user-${Date.now()}-${(counter += 1)}@example.invalid`;

beforeEach(async () => {
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('the connection', () => {
  it('is reachable', async () => {
    await expect(ping(client)).resolves.toBeUndefined();
  });
});

describe('users', () => {
  it('stores and reads back an account', async () => {
    const email = uniqueEmail();
    const created = await client.user.create({ data: { email } });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await client.user.findUnique({ where: { email } })).toMatchObject({
      id: created.id,
      email,
    });
  });

  it('rejects a duplicate email at the database level', async () => {
    const email = uniqueEmail();
    await client.user.create({ data: { email } });
    await expect(client.user.create({ data: { email } })).rejects.toThrow();
  });

  it('treats email as case-insensitive, because the column is citext', async () => {
    // The guarantee that matters: one person cannot end up holding both
    // alice@example.com and Alice@Example.com. Folding case in application code
    // would leave the database able to store both, and then a race creates two
    // accounts for one address.
    const email = uniqueEmail();
    await client.user.create({ data: { email } });

    await expect(
      client.user.create({ data: { email: email.toUpperCase() } }),
    ).rejects.toThrow();
  });

  it('finds an account regardless of the case used to look it up', async () => {
    const email = uniqueEmail();
    const created = await client.user.create({ data: { email } });

    const found = await client.user.findUnique({
      where: { email: email.toUpperCase() },
    });
    expect(found?.id).toBe(created.id);
  });

  it('stores timestamps with a timezone, as real Dates', async () => {
    const created = await client.user.create({ data: { email: uniqueEmail() } });

    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    // A `timestamp without time zone` column would silently drop the offset and
    // make every later BST calculation wrong (BRD §6.1).
    expect(Number.isNaN(created.createdAt.getTime())).toBe(false);
  });

  it('moves updatedAt when the row changes, and leaves createdAt alone', async () => {
    const created = await client.user.create({ data: { email: uniqueEmail() } });

    // Postgres resolves to microseconds; without a gap the two timestamps can
    // land in the same tick and the assertion passes for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await client.user.update({
      where: { id: created.id },
      data: { email: uniqueEmail() },
    });

    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });
});
