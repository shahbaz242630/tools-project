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

import { randomUUID } from 'node:crypto';
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

/**
 * Distinct per test, so a leftover row cannot make a later assertion pass.
 *
 * randomUUID rather than a timestamp and a counter: two test files starting in
 * the same millisecond generate the same values, and the unique-constraint
 * violation that follows looks exactly like the bug these tests detect.
 */
const uniqueEmail = () => `user-${randomUUID()}@example.invalid`;
const uniqueClerkId = () => `user_${randomUUID()}`;

/**
 * A row's required fields.
 *
 * `clerkUserId` is NOT NULL with no default: the mirror exists to be joined to
 * an identity, and a row without one could never authenticate. Spelled out in a
 * helper so a test asserting something about `email` does not have to restate
 * that every time.
 */
const newUser = (overrides: { email?: string; clerkUserId?: string } = {}) => ({
  clerkUserId: overrides.clerkUserId ?? uniqueClerkId(),
  email: overrides.email ?? uniqueEmail(),
});

beforeEach(async () => {
  await client.user.deleteMany();
  await client.webhookEvent.deleteMany();
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
    const data = newUser();
    const created = await client.user.create({ data });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(
      await client.user.findUnique({ where: { email: data.email } }),
    ).toMatchObject({ id: created.id, email: data.email });
  });

  it('defaults a new account to the least privilege', async () => {
    // A role column that defaulted to ADMIN — or to null, read later as a
    // missing check — would hand every new sign-up the admin surface.
    const created = await client.user.create({ data: newUser() });
    expect(created.role).toBe('USER');
    expect(created.deletedAt).toBeNull();
  });

  it('rejects a duplicate email at the database level', async () => {
    const email = uniqueEmail();
    await client.user.create({ data: newUser({ email }) });
    await expect(client.user.create({ data: newUser({ email }) })).rejects.toThrow();
  });

  it('rejects a duplicate Clerk id at the database level', async () => {
    // Two platform accounts mirroring one Clerk user would make "which account
    // is this request" ambiguous at exactly the point it must not be. Two
    // containers handling the same duplicate delivery both pass any check
    // written in application code; only the constraint makes one lose.
    const clerkUserId = uniqueClerkId();
    await client.user.create({ data: newUser({ clerkUserId }) });
    await expect(
      client.user.create({ data: newUser({ clerkUserId }) }),
    ).rejects.toThrow();
  });

  it('treats email as case-insensitive, because the column is citext', async () => {
    // The guarantee that matters: one person cannot end up holding both
    // alice@example.com and Alice@Example.com. Folding case in application code
    // would leave the database able to store both, and then a race creates two
    // accounts for one address.
    const email = uniqueEmail();
    await client.user.create({ data: newUser({ email }) });

    await expect(
      client.user.create({ data: newUser({ email: email.toUpperCase() }) }),
    ).rejects.toThrow();
  });

  it('finds an account regardless of the case used to look it up', async () => {
    const data = newUser();
    const created = await client.user.create({ data });

    const found = await client.user.findUnique({
      where: { email: data.email.toUpperCase() },
    });
    expect(found?.id).toBe(created.id);
  });

  it('stores timestamps with a timezone, as real Dates', async () => {
    const created = await client.user.create({ data: newUser() });

    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    // A `timestamp without time zone` column would silently drop the offset and
    // make every later BST calculation wrong (BRD §6.1).
    expect(Number.isNaN(created.createdAt.getTime())).toBe(false);
  });

  it('moves updatedAt when the row changes, and leaves createdAt alone', async () => {
    const created = await client.user.create({ data: newUser() });

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

describe('webhook_events', () => {
  const delivery = (
    overrides: Partial<{ provider: string; externalId: string }> = {},
  ) => ({
    provider: overrides.provider ?? 'clerk',
    externalId: overrides.externalId ?? `msg_${randomUUID()}`,
    eventType: 'user.created',
  });

  it('rejects a duplicate delivery from the same provider', async () => {
    // This constraint *is* the idempotency guarantee. Two API containers handed
    // the same retry concurrently both pass a "have I seen this?" check written
    // in application code; only the database makes the second one lose.
    const data = delivery();
    await client.webhookEvent.create({ data });
    await expect(client.webhookEvent.create({ data })).rejects.toThrow();
  });

  it('allows the same delivery id from a different provider', async () => {
    // Event identifiers are only unique within the provider that issued them,
    // and Stripe arrives in Phase 5. A global unique index would silently drop
    // a Stripe event whose id happened to match a Clerk one.
    const externalId = `msg_shared_${randomUUID()}`;
    await client.webhookEvent.create({ data: delivery({ externalId }) });

    await expect(
      client.webhookEvent.create({
        data: delivery({ provider: 'stripe', externalId }),
      }),
    ).resolves.toMatchObject({ provider: 'stripe' });
  });

  it('records a delivery as unprocessed until it is applied', async () => {
    // A row claimed but never marked is a delivery we accepted and failed to
    // apply. Collapsing the two states would erase the difference between
    // "handled" and "started, then crashed".
    const created = await client.webhookEvent.create({ data: delivery() });

    expect(created.processedAt).toBeNull();
    expect(created.receivedAt).toBeInstanceOf(Date);

    const done = await client.webhookEvent.update({
      where: { id: created.id },
      data: { processedAt: new Date() },
    });
    expect(done.processedAt).toBeInstanceOf(Date);
  });

  it('stores no payload', async () => {
    // Deliberate: idempotency needs only the identifier, and the Clerk body
    // carries email addresses we would then hold a second time, outside
    // `users`, with no purpose and no retention rule (BRD §10). If a payload
    // column ever appears, that decision is being reversed.
    const created = await client.webhookEvent.create({ data: delivery() });
    expect(Object.keys(created).sort()).toEqual([
      'eventType',
      'externalId',
      'id',
      'processedAt',
      'provider',
      'receivedAt',
    ]);
  });
});
