/**
 * The profile store against a real database, with real encryption.
 *
 * The in-memory fake models these rules; only Postgres enforces them, and only
 * this file proves that what lands in the `encryptedDetail` column is actually
 * unreadable. A fake encryptor would prove the code calls something — the point
 * here is that a person with the dump and no key gets nothing.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { PrismaProfileStore } from './prisma-profile-store.js';
import type { ProfileChanges } from './profile-store.js';

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

/** A fixed test key. Never the production one — that lives in the secret manager. */
const KEY = Buffer.alloc(32, 3).toString('base64');
const store = new PrismaProfileStore(client, createFieldEncryptor(KEY));

const changes: ProfileChanges = {
  displayName: 'Sarah M.',
  phone: '+447700900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: 'Flat 3',
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
  ownerStatus: null,
};

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
});

afterAll(async () => {
  await client.$disconnect();
});

describe('save and find', () => {
  it('round-trips a complete profile', async () => {
    const userId = await newUser();
    await store.save(userId, changes);

    await expect(store.find(userId)).resolves.toEqual({
      // The profile row's own id, which is what an audit entry names as its
      // target — using the user id would be ambiguous the moment profiles stop
      // being one-per-account.
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      userId,
      displayName: 'Sarah M.',
      phone: '+447700900123',
      address: {
        line1: '12 Acacia Avenue',
        line2: 'Flat 3',
        town: 'Bristol',
        postcode: 'BS7 8AA',
      },
      // Null because `changes` does not declare one, which is the state every
      // real account starts in (slice 2.13). `toEqual` rather than
      // `toMatchObject` is what makes this assertion useful: a field added to
      // `StoredProfile` and not to this expectation fails here, which is how a
      // new personal-data field gets noticed at the store boundary.
      ownerStatus: null,
      updatedAt: expect.any(Date),
    });
  });

  it('is null for a user with no profile', async () => {
    await expect(store.find(await newUser())).resolves.toBeNull();
  });

  it('creates on the first save and updates on the second', async () => {
    const userId = await newUser();
    await store.save(userId, changes);
    await store.save(userId, { ...changes, displayName: 'Sarah Mitchell' });

    expect(await client.profile.count()).toBe(1);
    await expect(store.find(userId)).resolves.toMatchObject({
      displayName: 'Sarah Mitchell',
    });
  });

  it('clears the address when one is removed, rather than leaving it behind', async () => {
    // The form sends the whole profile, so an absent address means the person
    // deleted it. Treating that as "no change" would leave a home address in
    // the database that its owner believes they have removed.
    const userId = await newUser();
    await store.save(userId, changes);
    await store.save(userId, { ...changes, address: null, phone: null });

    await expect(store.find(userId)).resolves.toMatchObject({
      address: null,
      phone: null,
    });
    expect(await client.address.count()).toBe(0);
  });

  it('derives the outward code on write', async () => {
    const userId = await newUser();
    await store.save(userId, changes);

    const row = await client.address.findUnique({ where: { userId } });
    expect(row?.outwardCode).toBe('BS7');
    expect(row?.postcode).toBe('BS7 8AA');
  });

  it('normalises the postcode before storing it', async () => {
    const userId = await newUser();
    await store.save(userId, {
      ...changes,
      address: { ...changes.address!, postcode: 'bs7  8aa' },
    });

    const row = await client.address.findUnique({ where: { userId } });
    expect(row?.postcode).toBe('BS7 8AA');
    expect(row?.outwardCode).toBe('BS7');
  });
});

describe('what is actually stored', () => {
  it('holds no street line in clear anywhere in the row', async () => {
    // The assertion that justifies the whole encryption path: this is what a
    // stolen backup or a mis-scoped read yields.
    const userId = await newUser();
    await store.save(userId, changes);

    const row = await client.address.findUnique({ where: { userId } });
    const serialised = JSON.stringify(row);

    expect(serialised).not.toContain('Acacia');
    expect(serialised).not.toContain('Flat 3');
    expect(row?.encryptedDetail).toMatch(/^v1:/);
  });

  it('still stores the postcode in clear, because Phase 3 must geocode it', async () => {
    // Deliberate, and the reason the columns are graded rather than the whole
    // address encrypted: a value the search index needs cannot be ciphertext.
    const userId = await newUser();
    await store.save(userId, changes);

    const row = await client.address.findUnique({ where: { userId } });
    expect(row?.postcode).toBe('BS7 8AA');
    expect(row?.town).toBe('Bristol');
  });

  it('produces different ciphertext for two people at the same address', async () => {
    // A fresh IV per encryption. Without it, identical addresses produce
    // identical ciphertext and the database leaks that two people live
    // together without anyone decrypting anything.
    const [one, two] = [await newUser(), await newUser()];
    await store.save(one, changes);
    await store.save(two, changes);

    const rows = await client.address.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows[0]?.encryptedDetail).not.toBe(rows[1]?.encryptedDetail);
  });

  it('cannot decrypt an address moved onto another person’s row', async () => {
    // The owner is bound into the ciphertext as additional authenticated data,
    // so this attack — available to anyone with database write access but no
    // key — fails rather than serving one person's address as another's.
    const [victim, attacker] = [await newUser(), await newUser()];
    await store.save(victim, changes);
    await store.save(attacker, { ...changes, address: null });

    const stolen = await client.address.findUnique({ where: { userId: victim } });
    await client.address.create({
      data: {
        userId: attacker,
        postcode: stolen!.postcode,
        outwardCode: stolen!.outwardCode,
        town: stolen!.town,
        encryptedDetail: stolen!.encryptedDetail,
      },
    });

    await expect(store.find(attacker)).rejects.toThrow(/could not be decrypted/);
  });
});

describe('constraints', () => {
  it('refuses an owner status the vocabulary does not know', async () => {
    /*
     * `owner_status_is_known`, watched failing (slice 2.13). Checked in the
     * database as well as in code, unlike `listings.status`, because the value
     * carries a **legal** meaning: a row written by a fixture script, a
     * migration or a hand-edit that this build cannot interpret would have a
     * public page state something untrue about somebody's capacity.
     */
    const userId = await newUser();
    await store.save(userId, changes);

    await expect(
      client.$executeRawUnsafe(
        `UPDATE profiles SET "ownerStatus" = 'sole_trader' WHERE "userId" = '${userId}'::uuid`,
      ),
    ).rejects.toThrow(/owner_status_is_known/);
  });

  it('permits null, which is what an unanswered declaration is', async () => {
    // The state every existing row was in when the column arrived, and the one
    // the publication gate refuses on. A NOT NULL here would have made the
    // migration impossible without inventing an answer for everybody.
    const userId = await newUser();

    await expect(store.save(userId, changes)).resolves.toMatchObject({
      ownerStatus: null,
    });
  });

  it('refuses a profile for an account that does not exist', async () => {
    // The foreign key. Without it a profile could outlive — or precede — the
    // account it belongs to, and every later join would need a null check.
    await expect(store.save(randomUUID(), changes)).rejects.toThrow();
  });

  it('keeps one person’s save out of another’s row', async () => {
    const [alice, bob] = [await newUser(), await newUser()];
    await store.save(alice, changes);
    await store.save(bob, { ...changes, displayName: 'Bob B.' });

    await expect(store.find(alice)).resolves.toMatchObject({ displayName: 'Sarah M.' });
    await expect(store.find(bob)).resolves.toMatchObject({ displayName: 'Bob B.' });
    expect(await client.profile.count()).toBe(2);
  });
});

describe('erase', () => {
  it('removes the profile and the address', async () => {
    const userId = await newUser();
    await store.save(userId, changes);

    await store.erase(userId);

    expect(await client.profile.count()).toBe(0);
    expect(await client.address.count()).toBe(0);
    await expect(store.find(userId)).resolves.toBeNull();
  });

  it('leaves the account row, which the ledger will reference', async () => {
    // A real delete of the personal data, and a deliberate non-delete of the
    // account. From Phase 5 the ledger points at this row and can never lose
    // its counterparty — that is the record we are obliged to keep, and it is
    // not the profile.
    const userId = await newUser();
    await store.save(userId, changes);

    await store.erase(userId);

    expect(await client.user.count()).toBe(1);
  });

  it('is idempotent', async () => {
    // A retry after a partial failure must be able to finish, and somebody who
    // never made a profile is still entitled to ask for erasure.
    const userId = await newUser();
    await store.save(userId, changes);

    await store.erase(userId);
    await expect(store.erase(userId)).resolves.toBeUndefined();
    await expect(store.erase(await newUser())).resolves.toBeUndefined();
  });

  it('touches nobody else’s rows', async () => {
    const [alice, bob] = [await newUser(), await newUser()];
    await store.save(alice, changes);
    await store.save(bob, changes);

    await store.erase(alice);

    expect(await client.profile.count()).toBe(1);
    await expect(store.find(bob)).resolves.not.toBeNull();
  });

  it('leaves no ciphertext behind for a stolen backup to hold', async () => {
    // The point of erasing rather than flagging. A soft-deleted address row
    // would keep the encrypted street lines in every backup taken afterwards,
    // with a retention clock nobody is watching.
    const userId = await newUser();
    await store.save(userId, changes);

    await store.erase(userId);

    expect(await client.address.findMany()).toEqual([]);
  });
});
