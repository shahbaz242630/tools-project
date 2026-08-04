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
  // Children before parents. The foreign keys are ON DELETE RESTRICT, so
  // clearing `users` first does not cascade — it throws, and every test in the
  // file then fails for a reason that has nothing to do with what it asserts.
  await client.profile.deleteMany();
  await client.address.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  // category_versions is ON DELETE RESTRICT against users, added in slice 2.1.
  // Children before parents, in every file -- not only the new one.
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  // seller_tax_profiles is ON DELETE RESTRICT against users too, added in 2.3.
  await client.sellerTaxProfile.deleteMany();
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

describe('profiles', () => {
  const newProfile = (userId: string) => ({ userId, displayName: 'Sarah M.' });

  it('stores a profile against an account', async () => {
    const user = await client.user.create({ data: newUser() });
    const created = await client.profile.create({ data: newProfile(user.id) });

    expect(created).toMatchObject({ userId: user.id, displayName: 'Sarah M.' });
    // Nullable because BRD §8.1 requires a verified phone before listing or
    // booking, not before having a profile.
    expect(created.phone).toBeNull();
  });

  it('allows only one profile per account', async () => {
    // Two profiles for one user makes "what is this person called" a question
    // with two answers, decided by whichever row sorts first.
    const user = await client.user.create({ data: newUser() });
    await client.profile.create({ data: newProfile(user.id) });

    await expect(
      client.profile.create({ data: newProfile(user.id) }),
    ).rejects.toThrow();
  });

  it('refuses a profile for an account that does not exist', async () => {
    // The foreign key, doing the job application code would otherwise have to
    // remember to do on every write path.
    await expect(
      client.profile.create({ data: newProfile(randomUUID()) }),
    ).rejects.toThrow();
  });

  it('allows two accounts to choose the same display name', async () => {
    // Deliberately not unique. Uniqueness invites squatting and a registration
    // race, and it does not stop impersonation anyway — "Support" and
    // "Support " are different strings. That is a Trust & Safety problem.
    const [one, two] = await Promise.all([
      client.user.create({ data: newUser() }),
      client.user.create({ data: newUser() }),
    ]);

    await client.profile.create({ data: newProfile(one.id) });
    await expect(
      client.profile.create({ data: newProfile(two.id) }),
    ).resolves.toMatchObject({ displayName: 'Sarah M.' });
  });

  it('blocks a hard delete of an account that still has a profile', async () => {
    // ON DELETE RESTRICT. Accounts are soft-deleted, so anything reaching this
    // constraint is doing what the identity module deliberately does not, and
    // failing loudly beats silently discarding the row.
    const user = await client.user.create({ data: newUser() });
    await client.profile.create({ data: newProfile(user.id) });

    await expect(client.user.delete({ where: { id: user.id } })).rejects.toThrow();
  });
});

describe('addresses', () => {
  const newAddress = (userId: string) => ({
    userId,
    postcode: 'BS7 8AA',
    outwardCode: 'BS7',
    town: 'Bristol',
    encryptedDetail: 'v1:aXY=:dGFn:Y2lwaGVy',
  });

  it('stores the public and private parts in separate columns', async () => {
    // The grading that makes a leak visible rather than silent: a public query
    // selects `outwardCode`, a column that has never held the inward code.
    const user = await client.user.create({ data: newUser() });
    const created = await client.address.create({ data: newAddress(user.id) });

    expect(created.outwardCode).toBe('BS7');
    expect(created.outwardCode).not.toContain('8AA');
    expect(created.postcode).toBe('BS7 8AA');
  });

  it('allows only one address per account', async () => {
    const user = await client.user.create({ data: newUser() });
    await client.address.create({ data: newAddress(user.id) });

    await expect(
      client.address.create({ data: newAddress(user.id) }),
    ).rejects.toThrow();
  });

  it('refuses an address for an account that does not exist', async () => {
    await expect(
      client.address.create({ data: newAddress(randomUUID()) }),
    ).rejects.toThrow();
  });

  it('holds street lines only as ciphertext', async () => {
    // The column stores an envelope, never plaintext. This asserts the shape
    // the schema expects; that the application never writes plaintext into it
    // is proved in the profiles module's own tests, against the real encryptor.
    const user = await client.user.create({ data: newUser() });
    const created = await client.address.create({ data: newAddress(user.id) });

    expect(created.encryptedDetail).toMatch(/^v1:/);
    expect(created.encryptedDetail).not.toContain('Acacia');
  });

  it('blocks a hard delete of an account that still has an address', async () => {
    const user = await client.user.create({ data: newUser() });
    await client.address.create({ data: newAddress(user.id) });

    await expect(client.user.delete({ where: { id: user.id } })).rejects.toThrow();
  });
});

describe('audit_logs', () => {
  const entry = (actorId: string | null) => ({
    actorId,
    action: 'profile.updated',
    targetType: 'profile',
    targetId: randomUUID(),
    beforeHash: 'a'.repeat(64),
    afterHash: 'b'.repeat(64),
    ipAddress: '203.0.113.7',
  });

  it('records an entry against an actor', async () => {
    const user = await client.user.create({ data: newUser() });
    const created = await client.auditLog.create({ data: entry(user.id) });

    expect(created).toMatchObject({
      actorId: user.id,
      action: 'profile.updated',
      targetType: 'profile',
    });
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('allows an entry with no actor, for actions nobody took', async () => {
    await expect(client.auditLog.create({ data: entry(null) })).resolves.toMatchObject({
      actorId: null,
    });
  });

  it('allows an entry with no address, because it is often genuinely unknown', async () => {
    // The API never sees a browser — only the web app is on the edge network —
    // so the address is only as good as the hop that forwarded it. Recording
    // the web container's own address instead would be misleading evidence.
    const user = await client.user.create({ data: newUser() });
    await expect(
      client.auditLog.create({ data: { ...entry(user.id), ipAddress: null } }),
    ).resolves.toMatchObject({ ipAddress: null });
  });

  it('rejects a malformed address at the database level', async () => {
    // The column is `inet`, so a value that is not an address cannot be stored
    // and later believed. The header it arrives on is attacker-influenced.
    const user = await client.user.create({ data: newUser() });
    await expect(
      client.auditLog.create({
        data: { ...entry(user.id), ipAddress: 'not-an-address' },
      }),
    ).rejects.toThrow();
  });

  it('stores an IPv6 address', async () => {
    const user = await client.user.create({ data: newUser() });
    await expect(
      client.auditLog.create({ data: { ...entry(user.id), ipAddress: '2001:db8::1' } }),
    ).resolves.toMatchObject({ ipAddress: '2001:db8::1' });
  });

  it('refuses an entry naming an actor that does not exist', async () => {
    // An audit trail naming somebody who never existed is worse than no trail.
    await expect(
      client.auditLog.create({ data: entry(randomUUID()) }),
    ).rejects.toThrow();
  });

  it('keeps the entry when a hard delete removes its actor', async () => {
    // ON DELETE SET NULL, unlike profiles' RESTRICT. Accounts are soft-deleted
    // so this should never fire — but if it ever does, losing the actor's name
    // is far better than losing the record that something happened. §10.1
    // retains security logs for six years; the event is the obligation.
    const user = await client.user.create({ data: newUser() });
    await client.auditLog.create({ data: entry(user.id) });

    await client.user.delete({ where: { id: user.id } });

    const remaining = await client.auditLog.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.actorId).toBeNull();
    expect(remaining[0]?.action).toBe('profile.updated');
  });

  it('stores no value, only digests of one', async () => {
    // BRD §6.2 records a *hash* of before and after. Storing the values would
    // make this table a second, longer-lived copy of the personal data the rest
    // of the system is careful about — retained six years while the original is
    // erasable, inverting §10.1. If a value column ever appears here, that
    // decision is being reversed (ADR 0017).
    const user = await client.user.create({ data: newUser() });
    const created = await client.auditLog.create({ data: entry(user.id) });

    expect(Object.keys(created).sort()).toEqual([
      'action',
      'actorId',
      'afterHash',
      'beforeHash',
      // Which sign-in the action happened in — an identifier for the *sitting*,
      // not for anything that changed. It joins to `authentication_events`,
      // which is where the device and the address live; on its own it says
      // nothing about a person and cannot be turned back into the state this
      // table refuses to store. Same category as `actorId` and `ipAddress`
      // beside it, and the same six-year retention argument covers it.
      'clerkSessionId',
      'createdAt',
      'id',
      'ipAddress',
      // Why, for actions that owe an explanation — an administrator reaching
      // into somebody else's account (BRD §8.13). Free text, and the one
      // column here a person writes: it is a stated justification, not a copy
      // of the data it justifies looking at.
      'reason',
      'targetId',
      'targetType',
    ]);
  });

  it('has no updatedAt, because nothing updates', async () => {
    // Append-only is the property; the absence of the column is the reminder.
    const user = await client.user.create({ data: newUser() });
    const created = await client.auditLog.create({ data: entry(user.id) });
    expect(created).not.toHaveProperty('updatedAt');
  });
});

/**
 * The seller tax profile — a table with no application code (§8.14.2).
 *
 * It exists so that activating statutory reporting is a configuration switch
 * rather than a rebuild, and while every category is flagged `none` nothing
 * writes here. That makes these the only tests it has, and it makes them worth
 * more than usual: **the constraints are the only thing that can refuse a bad
 * value, because there is no adapter to do it.** Everywhere else in this
 * codebase a closed vocabulary lives in TypeScript; here there is no TypeScript
 * to put it in yet.
 */
describe('seller_tax_profiles', () => {
  const newProfile = (userId: string) => ({
    userId,
    regime: 'uk_dprr',
    verificationState: 'not_started',
  });

  it('stores and reads back a profile', async () => {
    const user = await client.user.create({ data: newUser() });

    const created = await client.sellerTaxProfile.create({
      data: newProfile(user.id),
    });

    expect(created.userId).toBe(user.id);
    expect(created.regime).toBe('uk_dprr');
    expect(created.verificationState).toBe('not_started');
  });

  it('holds no personal data, deliberately', async () => {
    const user = await client.user.create({ data: newUser() });
    const created = await client.sellerTaxProfile.create({
      data: newProfile(user.id),
    });

    // §6.2 lists "collected fields" on this entity — a name, an address, a date
    // of birth, a taxpayer reference. They are absent on purpose: nothing
    // enumerates the tables holding personal data, so a fourth one added before
    // its eraser would be silently missing from deletion and from the export.
    // If this test starts failing, the columns arrived — and `PersonalDataEraser`
    // and both `PersonalDataSource` projections must arrive with them.
    expect(Object.keys(created).sort()).toEqual([
      'createdAt',
      'id',
      'regime',
      'updatedAt',
      'userId',
      'verificationState',
    ]);
  });

  it('allows only one profile per seller', async () => {
    const user = await client.user.create({ data: newUser() });
    await client.sellerTaxProfile.create({ data: newProfile(user.id) });

    // Two profiles for one seller means two answers to what gets filed.
    await expect(
      client.sellerTaxProfile.create({ data: newProfile(user.id) }),
    ).rejects.toThrow();
  });

  it('refuses a regime it does not know', async () => {
    const user = await client.user.create({ data: newUser() });

    await expect(
      client.sellerTaxProfile.create({
        data: { ...newProfile(user.id), regime: 'eu_dac7' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a verification state it does not know', async () => {
    const user = await client.user.create({ data: newUser() });

    await expect(
      client.sellerTaxProfile.create({
        data: { ...newProfile(user.id), verificationState: 'probably_fine' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a profile for a seller who does not exist', async () => {
    await expect(
      client.sellerTaxProfile.create({
        data: newProfile('00000000-0000-4000-8000-000000000000'),
      }),
    ).rejects.toThrow();
  });

  it('will not let a seller be deleted out from under it', async () => {
    // ON DELETE RESTRICT. It never fires in production — accounts are
    // soft-deleted — but a statutory record that a hard delete could take with
    // it would be the wrong shape for something retained against a filing
    // deadline.
    const user = await client.user.create({ data: newUser() });
    await client.sellerTaxProfile.create({ data: newProfile(user.id) });

    await expect(client.user.delete({ where: { id: user.id } })).rejects.toThrow();
  });
});
