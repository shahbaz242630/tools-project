/**
 * The listing adapter against a real database.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 *
 * The tests worth having here are the ones a double cannot fake: the composite
 * foreign key that makes a listing's category and its pinned version agree, the
 * RESTRICT that stops an owner disappearing, and what Postgres does with an
 * integer amount. Everything else about this store is covered by the integration
 * tests.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaCategoryStore } from './prisma-category-store.js';
import { PrismaListingStore } from './prisma-listing-store.js';
import { UnknownCategoryError } from './listing-store.js';

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

const categories = new PrismaCategoryStore(client);
const store = new PrismaListingStore(client);

async function newUser(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
    },
  });
  return user.id;
}

const slug = (): string => `cat-${randomUUID().slice(0, 8)}`;

async function newCategory(authorId: string, identity = slug()) {
  return categories.create(
    {
      slug: identity,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: [],
    },
    authorId,
  );
}

const draft = (ownerId: string, categorySlug: string) => ({
  ownerId,
  categorySlug,
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' } as const,
});

beforeEach(async () => {
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

describe('creating a draft', () => {
  it('writes the row and reads it back', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(draft(owner, category.slug));

    expect(created.title).toBe('Petrol hedge trimmer');
    expect(created.status).toBe('DRAFT');
    expect(created.categorySlug).toBe(category.slug);
    expect(await store.findOwnedBy(created.id, owner)).toMatchObject({
      id: created.id,
    });
  });

  it('pins the version in force at the moment it is written', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    await categories.addVersion(
      category.slug,
      {
        name: 'Garden and outdoor',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
      },
      owner,
    );

    const created = await store.createDraft(draft(owner, category.slug));

    expect(created.categoryVersionNumber).toBe(2);
  });

  it('leaves the pin alone when the category is reconfigured afterwards', async () => {
    // The property slice 2.4b depends on: the attribute values a listing holds
    // were validated against *this* schema, and a later reconfiguration must not
    // retroactively change which one that was.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await categories.addVersion(
      category.slug,
      {
        name: 'Garden and outdoor',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
      },
      owner,
    );

    const read = await store.findOwnedBy(created.id, owner);
    expect(read?.categoryVersionNumber).toBe(1);
    // And the name it reports is the pinned version's, not the current one.
    expect(read?.categoryName).toBe('Outdoor and gardening');
  });

  it('refuses a category that does not exist', async () => {
    const owner = await newUser();

    await expect(
      store.createDraft(draft(owner, 'no-such-category')),
    ).rejects.toBeInstanceOf(UnknownCategoryError);
  });

  it('stores the amount as an integer and the currency beside it', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    const row = await client.listing.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.replacementValueAmount).toBe(24_999);
    expect(Number.isInteger(row.replacementValueAmount)).toBe(true);
    expect(row.replacementValueCurrency).toBe('GBP');
  });
});

describe('the constraints', () => {
  it('will not let a listing claim one category and pin another’s version', async () => {
    // **The reason the composite foreign key exists.** Two independent keys
    // would each be individually valid in this state, nothing would notice, and
    // the listing would be validated against a schema from a category it does
    // not belong to.
    const owner = await newUser();
    const mine = await newCategory(owner);
    const other = await newCategory(owner);

    const otherVersion = await client.categoryVersion.findFirstOrThrow({
      where: { categoryId: other.id },
    });

    await expect(
      client.listing.create({
        data: {
          ownerId: owner,
          // Category from one, version from the other.
          categoryId: mine.id,
          categoryVersionId: otherVersion.id,
          title: 'Mismatched',
          description: '',
          replacementValueAmount: 1_000,
          replacementValueCurrency: 'GBP',
          status: 'DRAFT',
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts the pair when they do agree', async () => {
    // The other half: the constraint must not be refusing everything.
    const owner = await newUser();
    const category = await newCategory(owner);
    const version = await client.categoryVersion.findFirstOrThrow({
      where: { categoryId: category.id },
    });

    const created = await client.listing.create({
      data: {
        ownerId: owner,
        categoryId: category.id,
        categoryVersionId: version.id,
        title: 'Matched',
        description: '',
        replacementValueAmount: 1_000,
        replacementValueCurrency: 'GBP',
        status: 'DRAFT',
      },
    });

    expect(created.id).toBeTruthy();
  });

  it('will not let an owner be deleted out from under a listing', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    await store.createDraft(draft(owner, category.slug));

    await expect(client.user.delete({ where: { id: owner } })).rejects.toThrow();
  });

  it('will not let a pinned category version be deleted', async () => {
    // `category_versions` still allows DELETE (slice 2.1 left it deliberately),
    // and from here a listing is what actually holds one in place.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await expect(
      client.categoryVersion.delete({
        where: { id: await pinnedVersionIdOf(created.id) },
      }),
    ).rejects.toThrow();
  });
});

describe('reading', () => {
  it('gives nothing back to somebody who is not the owner', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    expect(await store.findOwnedBy(created.id, stranger)).toBeNull();
  });

  it('answers null for a listing that does not exist', async () => {
    const stranger = await newUser();

    expect(
      await store.findOwnedBy('00000000-0000-4000-9000-000000000999', stranger),
    ).toBeNull();
  });

  it('refuses to read a status this build does not know', async () => {
    // The same treatment `riskLevel` gets. Reading an unknown status as `DRAFT`
    // would present somebody's published listing as unpublished — and from 2.8
    // would offer to publish something that already is.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await client.$executeRaw`
      UPDATE "listings" SET "status" = 'ARCHIVED' WHERE "id" = ${created.id}::uuid
    `;

    await expect(store.findOwnedBy(created.id, owner)).rejects.toThrow(/status/i);
  });
});

describe('the category options', () => {
  it('lists categories oldest first with their current name', async () => {
    const author = await newUser();
    const first = await newCategory(author);
    const second = await newCategory(author);
    await categories.addVersion(
      second.slug,
      {
        name: 'Renamed',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
      },
      author,
    );

    const options = await store.listOptions();

    expect(options.map((option) => option.slug)).toEqual([first.slug, second.slug]);
    expect(options[1]?.name).toBe('Renamed');
  });

  it('exposes only the slug and the name', async () => {
    const author = await newUser();
    await newCategory(author);

    expect(Object.keys((await store.listOptions())[0] ?? {}).sort()).toEqual([
      'name',
      'slug',
    ]);
  });
});

async function pinnedVersionIdOf(listingId: string): Promise<string> {
  const row = await client.listing.findUniqueOrThrow({ where: { id: listingId } });
  return row.categoryVersionId;
}
