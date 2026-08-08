/**
 * The category adapter against a real database.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 *
 * The tests worth having here are the ones a double cannot fake: the trigger
 * that refuses an UPDATE, the unique constraint that makes two simultaneous
 * edits resolve to one, and the foreign key that stops an author disappearing.
 * Everything else about this store is exercised by the service tests.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaCategoryStore } from './prisma-category-store.js';
import { CategorySlugTakenError } from './category-store.js';
import { CATEGORY_LIST_LIMIT } from './limits.js';

/**
 * A priced category (BRD §8.2, §3.4, slice 2.7a).
 *
 * Real rates rather than zeroes: zero is what an unpriced category defaults to,
 * so a suite where every fixture is unpriced could not tell a policy that was
 * carried through from one that was silently dropped.
 */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};

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

const store = new PrismaCategoryStore(client);

async function newUser(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
    },
  });
  return user.id;
}

/** A slug per test, so nothing depends on the order they run in. */
const slug = (): string => `cat-${randomUUID().slice(0, 8)}`;

beforeEach(async () => {
  // Children before parents, in every file. `category_versions` references both
  // `categories` (CASCADE) and `users` (RESTRICT), and the RESTRICT is what
  // makes the order load-bearing rather than tidy.
  // listings reference both users and category_versions, ON DELETE RESTRICT
  // (slice 2.4a) — so they clear before either. Children before parents, in
  // every file.
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  await client.authenticationEvent.deleteMany();
  // seller_tax_profiles is ON DELETE RESTRICT against users (slice 2.3).
  // Children before parents, in every file — a new foreign key means editing
  // all of them, not only the one the slice was about.
  await client.sellerTaxProfile.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('create', () => {
  it('writes the category and its first version together', async () => {
    const author = await newUser();
    const created = await store.create(
      {
        slug: 'outdoor-gardening',
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    expect(created.versionNumber).toBe(1);

    const versions = await client.categoryVersion.findMany({
      where: { categoryId: created.id },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.createdById).toBe(author);
  });

  it('refuses a duplicate slug as a named error, not a Prisma code', async () => {
    const author = await newUser();
    const taken = slug();
    await store.create(
      {
        slug: taken,
        name: 'First',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    // The adapter's job: P2002 is a provider detail and must not reach a route,
    // which would otherwise have to know Prisma error codes to answer 409.
    await expect(
      store.create(
        {
          slug: taken,
          name: 'Second',
          riskLevel: 'low',
          reportableActivity: 'none',
          attributes: [],
          feePolicy: FEE_POLICY,
          transportOptions: [],
        },
        author,
      ),
    ).rejects.toBeInstanceOf(CategorySlugTakenError);
  });

  it('leaves no category behind when the slug is taken', async () => {
    const author = await newUser();
    const taken = slug();
    await store.create(
      {
        slug: taken,
        name: 'First',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );
    await expect(
      store.create(
        {
          slug: taken,
          name: 'Second',
          riskLevel: 'low',
          reportableActivity: 'none',
          attributes: [],
          feePolicy: FEE_POLICY,
          transportOptions: [],
        },
        author,
      ),
    ).rejects.toThrow();

    expect(await client.category.count({ where: { slug: taken } })).toBe(1);
  });
});

describe('the immutability trigger', () => {
  it('refuses an UPDATE of a version', async () => {
    const author = await newUser();
    const created = await store.create(
      {
        slug: slug(),
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    // Deliberately going around the store, because the store is not the thing
    // under test — the database is. The port has no update method precisely so
    // this cannot be reached in application code, and this proves the guarantee
    // survives somebody adding one.
    await expect(
      client.categoryVersion.updateMany({
        where: { categoryId: created.id },
        data: { name: 'Edited behind the port' },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it('leaves the row exactly as it was after a refused UPDATE', async () => {
    const author = await newUser();
    const created = await store.create(
      {
        slug: slug(),
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await expect(
      client.categoryVersion.updateMany({
        where: { categoryId: created.id },
        data: { name: 'Edited behind the port' },
      }),
    ).rejects.toThrow();

    const version = await client.categoryVersion.findFirst({
      where: { categoryId: created.id },
    });
    expect(version?.name).toBe('Original');
  });

  it('still allows a DELETE, which is deliberate', async () => {
    // Refusing DELETE would break every integration test's teardown and buy
    // nothing: from Phase 4 the thing that holds a referenced version in place
    // is a booking's foreign key, which expresses a real dependency.
    const author = await newUser();
    const created = await store.create(
      {
        slug: slug(),
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.deleteMany({ where: { categoryId: created.id } });
    expect(
      await client.categoryVersion.count({ where: { categoryId: created.id } }),
    ).toBe(0);
  });
});

describe('addVersion', () => {
  it('appends and leaves the previous version untouched', async () => {
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const updated = await store.addVersion(
      identity,
      {
        name: 'Renamed',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    expect(updated?.versionNumber).toBe(2);

    const versions = await client.categoryVersion.findMany({
      where: { category: { slug: identity } },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]?.name).toBe('Original');
    expect(versions[0]?.riskLevel).toBe('low');
  });

  it('refuses a second version with the same number', async () => {
    // The concurrency control, stated directly. Two administrators reading the
    // same current version compute the same next number; the constraint is what
    // makes the second write fail instead of silently winning.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await expect(
      client.categoryVersion.create({
        data: {
          categoryId: created.id,
          versionNumber: 1,
          name: 'Simultaneous',
          riskLevel: 'low',
          createdById: author,
        },
      }),
    ).rejects.toThrow();
  });

  it('answers null for a slug that does not exist', async () => {
    const author = await newUser();
    expect(
      await store.addVersion(
        'no-such-category',
        {
          name: 'X',
          riskLevel: 'low',
          reportableActivity: 'none',
          attributes: [],
          feePolicy: FEE_POLICY,
          transportOptions: [],
        },
        author,
      ),
    ).toBeNull();
  });
});

describe('the author foreign key', () => {
  it('refuses to remove a user who authored a configuration', async () => {
    const author = await newUser();
    await store.create(
      {
        slug: slug(),
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    // ON DELETE RESTRICT. Accounts are soft-deleted rather than removed, so this
    // constrains nothing in practice — but it is why every db test in the
    // repository now clears `category_versions` before `users`.
    await expect(client.user.delete({ where: { id: author } })).rejects.toThrow();
  });
});

describe('reads', () => {
  it('returns the newest version as the current configuration', async () => {
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );
    await store.addVersion(
      identity,
      {
        name: 'Second',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );
    await store.addVersion(
      identity,
      {
        name: 'Third',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const found = await store.findBySlug(identity);
    expect(found?.name).toBe('Third');
    expect(found?.riskLevel).toBe('high');
    expect(found?.versionNumber).toBe(3);
  });

  it('lists categories oldest first', async () => {
    const author = await newUser();
    const first = slug();
    const second = slug();
    await store.create(
      {
        slug: first,
        name: 'First',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );
    await store.create(
      {
        slug: second,
        name: 'Second',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const listed = await store.list(CATEGORY_LIST_LIMIT);
    expect(listed.map((category) => category.slug)).toEqual([first, second]);
  });

  /**
   * Slice H2 — the bound is in the query, and only a db test can see it.
   *
   * `CatalogueService` slices and reports truncation whatever the store hands
   * back, so its own tests pass with or without a `take` here. What they cannot
   * tell apart is a five-hundred-row query from a five-hundred-thousand-row one.
   */
  it('asks the database for no more categories than the limit', async () => {
    const author = await newUser();
    const first = slug();
    await store.create(
      {
        slug: first,
        name: 'First',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );
    await store.create(
      {
        slug: slug(),
        name: 'Second',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    // Oldest first, so the one kept is the one created first.
    expect((await store.list(1)).map((category) => category.slug)).toEqual([first]);
  });

  it('answers null for an unknown slug', async () => {
    expect(await store.findBySlug('no-such-category')).toBeNull();
  });

  it('refuses to read a risk level this build does not know', async () => {
    // Reading it as `low` would understate an item's handling requirements,
    // which is the wrong direction to be wrong in for something that will drive
    // deposits and verification.
    //
    // The column is plain `TEXT` with a closed union in code, so Prisma writes
    // this happily — which is exactly why the adapter has to check. A newer
    // build introducing a fourth level and an older one still running is the
    // real version of this.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'From the future',
        riskLevel: 'catastrophic',
        createdById: author,
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(/risk level/i);
  });
});

describe('the attribute schema', () => {
  const SCHEMA = [
    {
      key: 'power_source',
      label: 'Power source',
      required: true,
      type: 'choice' as const,
      options: [
        { value: 'petrol', label: 'Petrol' },
        { value: 'cordless', label: 'Cordless' },
      ],
    },
    {
      key: 'weight_kg',
      label: 'Weight',
      required: true,
      type: 'number' as const,
      unit: 'kg',
      decimalPlaces: 1,
    },
  ];

  it('round-trips through JSONB unchanged, order included', async () => {
    // Order is the render order (ADR 0027). Postgres preserves array order in
    // `jsonb` — it reorders *object keys*, which is why nothing here depends on
    // key order and everything depends on array order.
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const found = await store.findBySlug(identity);
    expect(found?.attributes).toEqual(SCHEMA);
    expect(found?.attributes.map((attribute) => attribute.key)).toEqual([
      'power_source',
      'weight_kg',
    ]);
  });

  it('reads a version written without the column as an empty schema', async () => {
    // This is the migration's claim, tested rather than asserted: a version that
    // predates slice 2.2 has no attributes and says so. The insert deliberately
    // omits the column so Postgres applies the DEFAULT, which is the only way to
    // reproduce a pre-existing row — writing `[]` by hand would prove nothing
    // about the default and everything about the test.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'As if written before the migration',
        riskLevel: 'low',
        createdById: author,
      },
    });

    const row = await client.categoryVersion.findFirst({
      where: { categoryId: created.id, versionNumber: 2 },
    });
    expect(row?.attributes).toEqual([]);

    // And it survives the adapter's parse, which is the half that matters —
    // a default the store then rejects would be worse than no default.
    expect((await store.findBySlug(identity))?.attributes).toEqual([]);
  });

  it('keeps the old schema when a new version replaces it', async () => {
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );
    await store.addVersion(
      identity,
      {
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const versions = await client.categoryVersion.findMany({
      where: { category: { slug: identity } },
      orderBy: { versionNumber: 'asc' },
    });
    // The guarantee §8.2 rests on: a listing filled in under version 1 still has
    // a schema to be read against, whatever version 2 says.
    expect(versions[0]?.attributes).toEqual(SCHEMA);
    expect(versions[1]?.attributes).toEqual([]);
  });

  it('still refuses an UPDATE after the column was added', async () => {
    // The migration is `ALTER TABLE ... ADD COLUMN`, which is DDL and does not
    // fire row-level triggers — so the immutability trigger neither had to be
    // dropped nor recreated. Asserted rather than reasoned about, because a
    // migration that silently disarmed it would look exactly like this one.
    const author = await newUser();
    const created = await store.create(
      {
        slug: slug(),
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await expect(
      client.categoryVersion.updateMany({
        where: { categoryId: created.id },
        data: { attributes: [] },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses to read a schema this build cannot render', async () => {
    // `jsonb` guarantees the value is JSON and nothing more. A row written by a
    // newer build — a fifth attribute type, say — must not be read as though the
    // field were absent, because a listing form that silently drops a required
    // field produces listings missing data nobody asked for.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'From the future',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [
          { key: 'available_from', label: 'From', required: false, type: 'date' },
        ],
        createdById: author,
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(/attribute schema/i);
  });

  it('names the category when it cannot read one', async () => {
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'Malformed',
        riskLevel: 'low',
        // Not even the right shape. The failure has to survive anything, not
        // only a plausible schema from a newer build.
        attributes: { power_source: 'petrol' },
        createdById: author,
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(identity);
  });
});

describe('the reportable-activity flag', () => {
  it('round-trips the head it was configured with', async () => {
    const author = await newUser();
    const identity = slug();

    const created = await store.create(
      {
        slug: identity,
        name: 'Trailers and towing',
        riskLevel: 'medium',
        reportableActivity: 'means_of_transport',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    expect(created.reportableActivity).toBe('means_of_transport');
    expect((await store.findBySlug(identity))?.reportableActivity).toBe(
      'means_of_transport',
    );
  });

  it('defaults a version written without one to none', async () => {
    // What every version configured before this migration has. The column was
    // added with DEFAULT 'none', and that is a statement of fact rather than a
    // convenience: §8.14.1 determined that rental of general goods is not a
    // Relevant Activity, so those categories were genuinely out of scope.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Configured before 2.3',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    // Written the way a pre-2.3 build wrote it: no such column in the INSERT.
    await client.$executeRaw`
      INSERT INTO "category_versions" ("id", "categoryId", "versionNumber", "name", "riskLevel", "createdById")
      VALUES (gen_random_uuid(), ${created.id}::uuid, 2, 'Older shape', 'low', ${author}::uuid)
    `;

    const read = await store.findBySlug(identity);
    expect(read?.versionNumber).toBe(2);
    expect(read?.reportableActivity).toBe('none');
  });

  it('keeps each version saying what it said when it was written', async () => {
    // The reason the flag is on the version and not on the category. A booking
    // made under version 1 was made under a category that was not reportable,
    // and no later configuration change may rewrite that.
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await store.addVersion(
      identity,
      {
        name: 'Outdoor, gardening and trailers',
        riskLevel: 'medium',
        reportableActivity: 'means_of_transport',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const versions = await client.categoryVersion.findMany({
      where: { category: { slug: identity } },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((version) => version.reportableActivity)).toEqual([
      'none',
      'means_of_transport',
    ]);
  });

  it('refuses to read a head this build does not know', async () => {
    // The same treatment `riskLevel` gets, and the stakes are higher. Falling
    // back to `none` would answer "no statutory obligation" on the strength of
    // not recognising a word, and the failure would surface as a missing annual
    // return rather than as an error.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'From a newer build',
        riskLevel: 'low',
        reportableActivity: 'crypto_asset_service',
        attributes: [],
        createdById: author,
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(/reportable activity/i);
  });
});

describe('the transport options', () => {
  const TRANSPORT = [
    { requirement: 'car_boot' as const, suggestedUpToKg: 25 },
    { requirement: 'van_required' as const, suggestedUpToKg: 150 },
  ];

  it('round-trips a selection with its thresholds through jsonb', async () => {
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: TRANSPORT,
      },
      author,
    );

    expect((await store.findBySlug(identity))?.transportOptions).toEqual(TRANSPORT);
  });

  it('keeps an option with no threshold absent rather than null', async () => {
    // One representation of "not configured". A jsonb round trip is exactly
    // where an absent key could come back as null without anybody noticing.
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [{ requirement: 'trailer_required' }],
      },
      author,
    );

    const read = (await store.findBySlug(identity))?.transportOptions;
    expect(read).toEqual([{ requirement: 'trailer_required' }]);
    expect(read?.[0]).not.toHaveProperty('suggestedUpToKg');
  });

  it('reads a version written before this column as offering nothing', async () => {
    // What every category configured before slice 2.4c is. The default is what
    // makes that a truthful answer rather than a crash, and no backfill invents
    // a selection nobody chose.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: TRANSPORT,
      },
      author,
    );

    // Written without the column at all, which is exactly what a row from
    // before the migration looks like.
    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'As if written before 2.4c',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        createdById: author,
      },
    });

    expect((await store.findBySlug(identity))?.transportOptions).toEqual([]);
  });

  it('leaves the previous version offering exactly what it offered', async () => {
    // The reason this lives on the version and not on the category: a listing
    // that named the van under version 1 must stay readable after the category
    // stops offering it.
    const author = await newUser();
    const identity = slug();
    await store.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: TRANSPORT,
      },
      author,
    );
    await store.addVersion(
      identity,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const versions = await client.categoryVersion.findMany({
      where: { category: { slug: identity } },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions[0]?.transportOptions).toEqual(TRANSPORT);
    expect(versions[1]?.transportOptions).toEqual([]);
  });

  it('refuses to read a selection this build cannot understand', async () => {
    // `asAttributes`' argument, and quieter. Falling back to an empty list would
    // present the category as offering *no* transport options — a listing form
    // that silently stops asking how an item is collected, with nothing on
    // screen to suggest anything is missing.
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'From a newer build',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        // A raw Prisma write, so the fee policy is its six columns rather than
        // the port's nested shape. Left at their defaults: this row exists to be
        // unreadable for its *transport* options, and giving it rates would
        // suggest the two were related.
        transportOptions: [{ requirement: 'helicopter_required' }],
        createdById: author,
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(/transport options/i);
  });

  it('names the category when it cannot read one', async () => {
    const author = await newUser();
    const identity = slug();
    const created = await store.create(
      {
        slug: identity,
        name: 'Original',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await client.categoryVersion.create({
      data: {
        categoryId: created.id,
        versionNumber: 2,
        name: 'Malformed',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        // Not even a list. The failure has to survive anything, not only a
        // plausible selection from a newer build.
        transportOptions: { requirement: 'car_boot' },
        createdById: author,
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(identity);
  });
});

/**
 * The fee policy (BRD §8.2, §3.4, slice 2.7a).
 *
 * These are the ones a double cannot fake: three CHECK constraints, and the
 * question of whether an earlier version keeps its own rates when a later one
 * changes them — which is the guarantee §8.2 asks this table to provide, and the
 * only reason the rates are on the version rather than on the category.
 */
describe('the fee policy', () => {
  it('round-trips through create', async () => {
    const author = await newUser();
    const identity = slug();

    const created = await store.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    expect(created.feePolicy).toEqual(FEE_POLICY);
    // Read back rather than trusted from the write, because the six columns are
    // assembled on the way out and a `toRecord` that dropped one would still
    // return the object `create` was handed.
    expect((await store.findBySlug(identity))?.feePolicy).toEqual(FEE_POLICY);
  });

  /**
   * The whole reason the policy is on the version.
   *
   * §8.2 requires a booking to retain the configuration it was made under, and
   * from Phase 4 a booking pins a version. If reconfiguring re-priced version 1,
   * every completed booking's fees would move retrospectively — and nothing
   * would report it, because the row would simply read differently than it did.
   */
  it('leaves an earlier version priced as it was', async () => {
    const author = await newUser();
    const identity = slug();

    await store.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    await store.addVersion(
      identity,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: { ...FEE_POLICY, renterFeeBasisPoints: 1_200 },
        transportOptions: [],
      },
      author,
    );

    const versions = await client.categoryVersion.findMany({
      where: { category: { slug: identity } },
      orderBy: { versionNumber: 'asc' },
    });

    expect(versions[0]?.renterFeeBasisPoints).toBe(800);
    expect(versions[1]?.renterFeeBasisPoints).toBe(1_200);
    // And the current read is the new one, so "current" still means highest.
    expect((await store.findBySlug(identity))?.feePolicy.renterFeeBasisPoints).toBe(
      1_200,
    );
  });

  it('defaults an unpriced category to charging nothing', async () => {
    const author = await newUser();
    const identity = slug();
    const category = await client.category.create({ data: { slug: identity } });

    // A version written without any fee columns, which is exactly what every row
    // predating this migration is.
    await client.categoryVersion.create({
      data: {
        categoryId: category.id,
        versionNumber: 1,
        name: 'Configured before fees existed',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        transportOptions: [],
        createdById: author,
      },
    });

    expect((await store.findBySlug(identity))?.feePolicy).toEqual({
      ownerCommissionBasisPoints: 0,
      renterFeeBasisPoints: 0,
      minimumBookingTotal: { amount: 0, currency: 'GBP' },
      minimumPlatformFee: { amount: 0, currency: 'GBP' },
    });
  });

  /**
   * Each CHECK, watched failing.
   *
   * The contract refuses all three before a request reaches the store, so these
   * writes go through Prisma directly — which is the point. The constraint exists
   * because the contract's bounds are constants in a TypeScript file somebody can
   * raise in one line, and what they guard is how much money the platform takes
   * from a stranger.
   */
  async function writeVersion(data: Record<string, unknown>): Promise<void> {
    const author = await newUser();
    const category = await client.category.create({ data: { slug: slug() } });

    await client.categoryVersion.create({
      data: {
        categoryId: category.id,
        versionNumber: 1,
        name: 'Probe',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        transportOptions: [],
        createdById: author,
        ...data,
      },
    });
  }

  it('refuses a rate above the ceiling, in the database', async () => {
    await expect(writeVersion({ renterFeeBasisPoints: 5_001 })).rejects.toThrow(
      /fee_rates_are_within_bounds/,
    );
  });

  it('refuses a negative rate, in the database', async () => {
    await expect(writeVersion({ ownerCommissionBasisPoints: -1 })).rejects.toThrow(
      /fee_rates_are_within_bounds/,
    );
  });

  it('refuses a negative floor, in the database', async () => {
    await expect(writeVersion({ minimumPlatformFeeAmount: -1 })).rejects.toThrow(
      /fee_floors_are_not_negative/,
    );
  });

  it('refuses a fee floor above the booking floor, in the database', async () => {
    await expect(
      writeVersion({ minimumPlatformFeeAmount: 100, minimumBookingTotalAmount: 50 }),
    ).rejects.toThrow(/platform_fee_floor_does_not_exceed_booking_floor/);
  });

  /**
   * A currency this build cannot do arithmetic in.
   *
   * Reading it as GBP would be worse than failing: `Money`'s operations refuse a
   * mismatched pair, so the error would surface deep inside a fee calculation
   * with a message about currencies rather than about a category — if it
   * surfaced at all. Naming the category is the only useful question.
   */
  it('refuses to read a fee policy in an unknown currency', async () => {
    const author = await newUser();
    const identity = slug();
    const category = await client.category.create({ data: { slug: identity } });

    await client.categoryVersion.create({
      data: {
        categoryId: category.id,
        versionNumber: 1,
        name: 'From a newer build',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        transportOptions: [],
        createdById: author,
        minimumBookingTotalCurrency: 'EUR',
        minimumPlatformFeeCurrency: 'EUR',
      },
    });

    await expect(store.findBySlug(identity)).rejects.toThrow(identity);
    await expect(store.findBySlug(identity)).rejects.toThrow(/EUR/);
  });
});
