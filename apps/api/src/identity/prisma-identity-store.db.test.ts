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
  await client.adminApproval.deleteMany();
  // authentication_events is ON DELETE RESTRICT, added in slice 1.11a.
  // Children before parents, in every file — not only the new one.
  await client.authenticationEvent.deleteMany();
  // category_versions is ON DELETE RESTRICT against users, added in slice 2.1.
  // Children before parents, in every file -- not only the new one.
  // listings reference both users and category_versions, ON DELETE RESTRICT
  // (slice 2.4a) — so they clear before either. Children before parents, in
  // every file.
  // Bookings sit above listings from slice 4.2, so they truncate first or the
  // foreign key refuses — children before parents, this suite's standing rule.
  await client.booking.deleteMany();
  await client.quote.deleteMany();
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  // seller_tax_profiles is ON DELETE RESTRICT against users (slice 2.3).
  // Children before parents, in every file — a new foreign key means editing
  // all of them, not only the one the slice was about.
  await client.sellerTaxProfile.deleteMany();
  // Before `users`: `feature_flag_overrides.changedById` is ON DELETE
  // RESTRICT, so an override left behind blocks the account it names
  // (slice H3a). Children before parents — the rule every file here keeps.
  await client.featureFlagOverride.deleteMany();
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

    const { user, created } = await users.upsert({ clerkUserId, email });

    expect(user).toMatchObject({ clerkUserId, email, role: 'USER', deletedAt: null });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    // Reported, not inferred: "this account came into existence" is auditable
    // and a read beforehand would be a lie under concurrency.
    expect(created).toBe(true);
  });

  it('returns the existing row rather than creating a second', async () => {
    const clerkUserId = uniqueClerkId();
    const first = await users.upsert({ clerkUserId, email: uniqueEmail() });
    const second = await users.upsert({ clerkUserId, email: uniqueEmail() });

    expect(second.user.id).toBe(first.user.id);
    expect(await client.user.count()).toBe(1);
    // Only the first call created it, so only the first is audited.
    expect([first.created, second.created]).toEqual([true, false]);
  });

  it('keeps the stored address when a repeat upsert carries a different one', async () => {
    // `upsert` provisions; it does not reconcile. Changing the address is the
    // service's decision, made after comparing — otherwise a stale replayed
    // webhook would overwrite a newer address on its way past.
    const clerkUserId = uniqueClerkId();
    const original = uniqueEmail();
    await users.upsert({ clerkUserId, email: original });

    const again = await users.upsert({ clerkUserId, email: uniqueEmail() });
    expect(again.user.email).toBe(original);
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
    const { user: original } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email,
    });

    await users.update(original.id, {
      deletedAt: new Date(),
      email: `deleted+${original.id}@deleted.invalid`,
    });

    const { user: returning } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email,
    });
    expect(returning.id).not.toBe(original.id);
    expect(returning.email).toBe(email);
  });

  it('reports a colliding email correction as a conflict, not a raw error', async () => {
    // The collision the correction path has to survive: our mirror holds a
    // stale address that another row already carries. Postgres raises P2002;
    // the store turns it into the domain error so the service can decide that
    // a stale mirror beats a 500 on an ordinary page load (ADR 0020).
    const taken = uniqueEmail();
    await users.upsert({ clerkUserId: uniqueClerkId(), email: taken });
    const { user } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email: uniqueEmail(),
    });

    await expect(users.update(user.id, { email: taken })).rejects.toThrow(
      UserConflictError,
    );
  });

  it('treats a case-different collision as a collision, because citext', async () => {
    const taken = uniqueEmail();
    await users.upsert({ clerkUserId: uniqueClerkId(), email: taken });
    const { user } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email: uniqueEmail(),
    });

    await expect(users.update(user.id, { email: taken.toUpperCase() })).rejects.toThrow(
      UserConflictError,
    );
  });

  it('still applies a correction that does not collide', async () => {
    const { user } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email: uniqueEmail(),
    });
    const next = uniqueEmail();

    await expect(users.update(user.id, { email: next })).resolves.toMatchObject({
      email: next,
    });
  });

  it('reads the role back as one of the two values', async () => {
    const { user } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email: uniqueEmail(),
    });
    await client.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });

    expect((await users.findByClerkUserId(user.clerkUserId))?.role).toBe('ADMIN');
  });
});

describe('suspension', () => {
  async function newAdmin(): Promise<string> {
    const { user } = await users.upsert({
      clerkUserId: uniqueClerkId(),
      email: uniqueEmail(),
    });
    await client.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    return user.id;
  }

  it('refuses a half-written suspension, because of the CHECK constraint', async () => {
    // A row with a `suspendedAt` and no reason is one the account page cannot
    // render sensibly — it would tell somebody they are suspended and be unable
    // to say why. All three columns or none.
    const admin = await newAdmin();

    await expect(
      client.user.update({
        where: { id: admin },
        data: { suspendedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('accepts a complete suspension', async () => {
    // The counterpart. Without it the test above would pass just as well if the
    // constraint refused every suspension.
    const [admin, target] = [await newAdmin(), await newAdmin()];

    await expect(
      client.user.update({
        where: { id: target },
        data: {
          suspendedAt: new Date(),
          suspendedById: admin,
          suspensionReason: 'suspected fraud, ticket 4821',
        },
      }),
    ).resolves.toMatchObject({ suspendedById: admin });
  });

  it('reads the suspension back onto the mirrored user', async () => {
    const [admin, target] = [await newAdmin(), await newAdmin()];
    await client.user.update({
      where: { id: target },
      data: {
        suspendedAt: new Date(),
        suspendedById: admin,
        suspensionReason: 'suspected fraud, ticket 4821',
      },
    });

    const read = await users.findById(target);
    expect(read?.suspendedAt).not.toBeNull();
    expect(read?.suspensionReason).toBe('suspected fraud, ticket 4821');
  });

  it('does not count a suspended administrator', async () => {
    // The interaction with slice 1.9's last-administrator rule. A suspended
    // administrator holds the role and cannot use it, so counting them would
    // let the last *usable* one be demoted on the strength of somebody who
    // cannot act.
    const [keeper, suspended] = [await newAdmin(), await newAdmin()];
    expect(await users.countAdministrators()).toBe(2);

    await client.user.update({
      where: { id: suspended },
      data: {
        suspendedAt: new Date(),
        suspendedById: keeper,
        suspensionReason: 'suspected fraud, ticket 4821',
      },
    });

    expect(await users.countAdministrators()).toBe(1);
  });

  it('does not count a deleted administrator either', async () => {
    const admin = await newAdmin();
    expect(await users.countAdministrators()).toBe(1);

    await client.user.update({ where: { id: admin }, data: { deletedAt: new Date() } });

    expect(await users.countAdministrators()).toBe(0);
  });

  it('reverses cleanly, leaving nothing on the row', async () => {
    // Suspension destroys nothing — unlike deletion, which erases. The audit
    // trail is what remembers it ever happened.
    const [admin, target] = [await newAdmin(), await newAdmin()];
    await client.user.update({
      where: { id: target },
      data: {
        suspendedAt: new Date(),
        suspendedById: admin,
        suspensionReason: 'suspected fraud, ticket 4821',
      },
    });

    await client.user.update({
      where: { id: target },
      data: { suspendedAt: null, suspendedById: null, suspensionReason: null },
    });

    const read = await users.findById(target);
    expect(read?.suspendedAt).toBeNull();
    expect(read?.suspensionReason).toBeNull();
  });

  it('keeps the suspension when the suspending administrator is removed', async () => {
    // ON DELETE SET NULL. Losing who did it is bad, but an old suspension must
    // never block removing an account, and the audit trail holds the actor.
    const [admin, target] = [await newAdmin(), await newAdmin()];
    await client.user.update({
      where: { id: target },
      data: {
        suspendedAt: new Date(),
        suspendedById: admin,
        suspensionReason: 'suspected fraud, ticket 4821',
      },
    });

    await client.user.delete({ where: { id: admin } });

    const read = await users.findById(target);
    expect(read?.suspendedAt).not.toBeNull();
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
