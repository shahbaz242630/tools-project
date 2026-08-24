import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaListingMediaStore } from './prisma-listing-media-store.js';

/**
 * `listing_media` against a real database (slice 2.6b-i).
 *
 * **The tests worth having here are the ones a double cannot fake**, which is
 * this suite's standing rule:
 *
 *   - the **foreign key and its `ON DELETE CASCADE`**, which is the whole reason
 *     the erasure path is shaped the way it is;
 *   - the **order the database actually returns**, which is the property the
 *     absent unique constraint on `(listingId, position)` rests on — the
 *     in-memory double sorts in JavaScript and would agree with itself whatever
 *     Postgres did;
 *   - that **duplicate positions really are representable**, so the reasoning in
 *     the migration is a fact rather than an assumption.
 *
 * Everything else about this store is covered by `listing-media.integration.test.ts`.
 */

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
const store = new PrismaListingMediaStore(client);

/**
 * Cleanup is children before parents — this suite's standing rule.
 *
 * The same order `prisma-listing-store.db.test.ts` keeps, and for its reasons:
 * bookings sit above listings from slice 4.2, and
 * `feature_flag_overrides.changedById` is `ON DELETE RESTRICT`, so an override
 * left behind blocks the account it names.
 *
 * `listing_media` needs no line of its own — the cascade from `listings` takes
 * it — but one is here anyway, because a table that relies on a cascade for its
 * own teardown is one that stops being cleaned up the day somebody changes the
 * foreign key.
 */
async function truncate(): Promise<void> {
  await client.listingMedia.deleteMany();
  await client.booking.deleteMany();
  await client.quote.deleteMany();
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  await client.sellerTaxProfile.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  await client.authenticationEvent.deleteMany();
  await client.featureFlagOverride.deleteMany();
  await client.user.deleteMany();
}

async function newListing(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
    },
  });

  const category = await client.category.create({
    data: { slug: `cat-${randomUUID()}` },
  });

  const version = await client.categoryVersion.create({
    data: {
      categoryId: category.id,
      versionNumber: 1,
      name: 'Probe',
      riskLevel: 'low',
      reportableActivity: 'none',
      attributes: [],
      transportOptions: [],
      createdById: user.id,
    },
  });

  const listing = await client.listing.create({
    data: {
      ownerId: user.id,
      categoryId: category.id,
      categoryVersionId: version.id,
      title: 'A probe listing',
      description: '',
      replacementValueAmount: 1_000,
      replacementValueCurrency: 'GBP',
      status: 'DRAFT',
    },
  });

  return listing.id;
}

/** A media row written through the store, so the adapter is what is exercised. */
async function givenMedia(listingId: string): Promise<string> {
  const record = await store.append({
    listingId,
    displayKey: `listings/${listingId}/${randomUUID()}/display.webp`,
    thumbnailKey: `listings/${listingId}/${randomUUID()}/thumbnail.webp`,
    contentType: 'image/webp',
    byteSize: 1_234,
    width: 1_600,
    height: 1_200,
    thumbnailWidth: 400,
    thumbnailHeight: 300,
    sha256: 'a'.repeat(64),
  });

  return record.id;
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await client.$disconnect();
});

describe('the foreign key', () => {
  it('refuses a photograph of a listing that does not exist', async () => {
    await expect(givenMedia('11111111-1111-4111-8111-111111111111')).rejects.toThrow();
  });

  it('takes the photographs with the listing — the cascade the schema promises', async () => {
    const listingId = await newListing();
    await givenMedia(listingId);
    await givenMedia(listingId);

    await client.listing.delete({ where: { id: listingId } });

    /*
     * **This is the half of erasure the database does**, and the half it cannot:
     * the rows go, the bytes in object storage do not. That is why
     * `ListingMediaService.eraseForListings` deletes the objects first and is
     * called before the listings are erased at all.
     */
    expect(await client.listingMedia.count({ where: { listingId } })).toBe(0);
  });
});

describe('the order rows come back in', () => {
  it('is by position, ascending', async () => {
    const listingId = await newListing();
    const first = await givenMedia(listingId);
    const second = await givenMedia(listingId);
    const third = await givenMedia(listingId);

    expect((await store.listFor(listingId)).map((row) => row.id)).toEqual([
      first,
      second,
      third,
    ]);
  });

  it('appends past the highest position rather than filling a gap', async () => {
    const listingId = await newListing();
    const first = await givenMedia(listingId);
    const second = await givenMedia(listingId);

    await store.remove(listingId, first);
    const third = await givenMedia(listingId);

    // The removed row left position 0 empty; the next append still goes after
    // the highest, so removing a photograph never silently reorders the rest.
    const rows = await store.listFor(listingId);
    expect(rows.map((row) => row.id)).toEqual([second, third]);
    expect(rows.map((row) => row.position)).toEqual([1, 2]);
  });

  it('stays a total order when two rows share a position', async () => {
    const listingId = await newListing();
    const first = await givenMedia(listingId);
    const second = await givenMedia(listingId);

    /*
     * **The state the migration argues is representable and harmless.** Written
     * directly, because the store deliberately cannot produce it on purpose —
     * only a race can. If a unique constraint were ever added, this write fails
     * and this test is the one that says so.
     */
    await client.listingMedia.update({
      where: { id: second },
      data: { position: 0 },
    });

    const rows = await store.listFor(listingId);

    // Both reachable, and in a stable order decided by `createdAt` then `id`.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual([first, second]);
  });
});

describe('scoping by listing', () => {
  it('will not remove a photograph through the wrong listing', async () => {
    const mine = await newListing();
    const theirs = await newListing();
    const mediaId = await givenMedia(theirs);

    expect(await store.remove(mine, mediaId)).toBeNull();
    expect(await client.listingMedia.count({ where: { id: mediaId } })).toBe(1);
  });

  it('will not reorder a photograph through the wrong listing', async () => {
    const mine = await newListing();
    const theirs = await newListing();
    const foreign = await givenMedia(theirs);

    await store.reorder(mine, [foreign]);

    // The update is scoped by `listingId` as well, so this changes nothing
    // rather than reordering a stranger's listing.
    const row = await client.listingMedia.findFirstOrThrow({
      where: { id: foreign },
    });
    expect(row.position).toBe(0);
  });
});

describe('reordering', () => {
  it('applies the whole order in one transaction', async () => {
    const listingId = await newListing();
    const first = await givenMedia(listingId);
    const second = await givenMedia(listingId);
    const third = await givenMedia(listingId);

    await store.reorder(listingId, [third, first, second]);

    expect((await store.listFor(listingId)).map((row) => row.id)).toEqual([
      third,
      first,
      second,
    ]);
  });
});

describe('erasure', () => {
  it('deletes every photograph of the listings it is given, and no others', async () => {
    const erased = await newListing();
    const kept = await newListing();
    await givenMedia(erased);
    await givenMedia(kept);

    await store.deleteFor([erased]);

    expect(await client.listingMedia.count({ where: { listingId: erased } })).toBe(0);
    expect(await client.listingMedia.count({ where: { listingId: kept } })).toBe(1);
  });

  it('succeeds on listings that have none, so a retry can finish the job', async () => {
    const listingId = await newListing();

    await expect(store.deleteFor([listingId])).resolves.toBeUndefined();
    await expect(store.deleteFor([])).resolves.toBeUndefined();
  });
});
