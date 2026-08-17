/**
 * Quotes against a real PostgreSQL (slice 4.4b).
 *
 * Needs `pnpm db:up` and migrations applied to the test database.
 *
 * **What only this file can prove.** Four things, and each is a place where the
 * in-memory fake is structurally unable to be evidence:
 *
 * - the **line items survive the `jsonb` round trip** and come back as the shape
 *   the contract describes, which is what the price is explained by;
 * - the three **CHECK constraints** hold — an empty hire, negative money, a total
 *   that is not its own parts, and an empty breakdown are all refused by the
 *   database rather than only by the application;
 * - deleting a **listing** takes its quotes with it, and deleting a
 *   **category version** a quote priced under is refused;
 * - the **money columns reassemble** into `Money` values with their currency.
 *
 * Everything else here is behaviour `InMemoryQuoteStore` models identically.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAXIMUM_RENTAL_DAYS } from '@platform/contracts';
import type { QuoteLineItem } from '@platform/contracts';
import { PrismaCategoryStore } from '../catalogue/prisma-category-store.js';
import { PrismaListingStore } from '../catalogue/prisma-listing-store.js';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { PrismaQuoteStore } from './prisma-quote-store.js';
import type { NewQuote } from './quote-store.js';

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
const listings = new PrismaListingStore(
  client,
  createFieldEncryptor(Buffer.alloc(32, 7).toString('base64')),
);
const store = new PrismaQuoteStore(client);

const FRIDAY = new Date('2026-09-11T23:00:00Z');
const MONDAY = new Date('2026-09-14T23:00:00Z');
const EXPIRES = new Date('2026-09-10T12:30:00Z');

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

const LINE_ITEMS: readonly QuoteLineItem[] = [
  { unit: 'day', count: 3, unitPrice: gbp(1_800), subtotal: gbp(5_400) },
];

beforeEach(async () => {
  // Children before parents. Quotes cascade from listings and users, but
  // truncating them explicitly keeps this list readable as the order it is.
  await client.quote.deleteMany();
  await client.availabilityBlock.deleteMany();
  await client.booking.deleteMany();
  await client.listingLocation.deleteMany();
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  await client.sellerTaxProfile.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  await client.authenticationEvent.deleteMany();
  await client.featureFlagOverride.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
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

interface Fixture {
  readonly listingId: string;
  readonly renterId: string;
  readonly categoryVersionId: string;
}

async function newFixture(): Promise<Fixture> {
  const owner = await newUser();
  const category = await categories.create(
    {
      slug: `cat-${randomUUID().slice(0, 8)}`,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: [],
      feePolicy: {
        ownerCommissionBasisPoints: 1_500,
        renterFeeBasisPoints: 800,
        minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
        minimumPlatformFee: { amount: 100, currency: 'GBP' },
      },
      transportOptions: [],
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
    },
    owner,
  );

  const listing = await listings.createDraft({
    ownerId: owner,
    categorySlug: category.slug,
    title: 'Petrol hedge trimmer',
    description: 'Serviced last spring.',
    replacementValue: { amount: 24_999, currency: 'GBP' },
    attributes: {},
    transportRequirement: null,
    requiresTwoPersonLift: false,
    collectionLocation: null,
    locatedPoint: null,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
    categoryVersionNumber: 1,
  });

  const version = await client.categoryVersion.findFirstOrThrow({
    where: { categoryId: category.id },
  });

  return {
    listingId: listing.id,
    renterId: await newUser(),
    categoryVersionId: version.id,
  };
}

function quoteFor(fixture: Fixture, overrides: Partial<NewQuote> = {}): NewQuote {
  return {
    listingId: fixture.listingId,
    renterId: fixture.renterId,
    startAt: FRIDAY,
    endAt: MONDAY,
    timeZone: 'Europe/London',
    renterPostcode: 'BS7 8AA',
    itemCharge: gbp(5_400),
    renterFee: gbp(432),
    total: gbp(5_832),
    minimumFeeApplied: false,
    lineItems: LINE_ITEMS,
    categoryVersionId: fixture.categoryVersionId,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

describe('storing a quote', () => {
  it('reads back every field it was given', async () => {
    const fixture = await newFixture();

    const created = await store.create(quoteFor(fixture));
    const read = await store.findForRenter(created.id, fixture.renterId);

    expect(read).toEqual(created);
    expect(read?.renterPostcode).toBe('BS7 8AA');
    expect(read?.timeZone).toBe('Europe/London');
    expect(read?.categoryVersionId).toBe(fixture.categoryVersionId);
  });

  it('brings the line items back through jsonb as the contract shape', async () => {
    // The one column whose shape Postgres cannot check beyond "a non-empty
    // array" — and the one the price is explained by.
    const fixture = await newFixture();

    const created = await store.create(
      quoteFor(fixture, {
        lineItems: [
          { unit: 'week', count: 1, unitPrice: gbp(9_000), subtotal: gbp(9_000) },
          { unit: 'day', count: 2, unitPrice: gbp(1_800), subtotal: gbp(3_600) },
        ],
      }),
    );

    const read = await store.findForRenter(created.id, fixture.renterId);

    expect(read?.lineItems).toEqual([
      { unit: 'week', count: 1, unitPrice: gbp(9_000), subtotal: gbp(9_000) },
      { unit: 'day', count: 2, unitPrice: gbp(1_800), subtotal: gbp(3_600) },
    ]);
  });

  it('reassembles the three amounts with their currency', async () => {
    const fixture = await newFixture();

    const created = await store.create(quoteFor(fixture));

    // One currency column, three amounts — ADR 0002's shape, reassembled here
    // rather than at every caller.
    expect(created.itemCharge).toEqual(gbp(5_400));
    expect(created.renterFee).toEqual(gbp(432));
    expect(created.total).toEqual(gbp(5_832));
  });

  it('keeps the period as the instants it was given, with the end exclusive', async () => {
    const fixture = await newFixture();

    const created = await store.create(quoteFor(fixture));

    expect(created.startAt.toISOString()).toBe(FRIDAY.toISOString());
    expect(created.endAt.toISOString()).toBe(MONDAY.toISOString());
  });
});

describe('what the database refuses', () => {
  it('refuses a period that is not a hire', async () => {
    const fixture = await newFixture();

    // `quote_period_is_a_hire`. The application refuses this long before here —
    // `refusePeriod` calls it "inverted" — and the point of the constraint is
    // that a future writer who has not read that code still cannot store it.
    await expect(
      store.create(quoteFor(fixture, { startAt: MONDAY, endAt: MONDAY })),
    ).rejects.toThrow();
  });

  it('refuses a total that is not the sum of its parts', async () => {
    const fixture = await newFixture();

    // `quote_money_is_not_negative`. The total is stored rather than derived
    // because it is the number a person was shown (§3.4.4), so the relationship
    // is asserted rather than assumed.
    await expect(
      store.create(quoteFor(fixture, { total: gbp(9_999) })),
    ).rejects.toThrow();
  });

  it('refuses negative money', async () => {
    const fixture = await newFixture();

    await expect(
      store.create(
        quoteFor(fixture, {
          itemCharge: gbp(-100),
          renterFee: gbp(0),
          total: gbp(-100),
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a quote with no line items, because it could not be explained', async () => {
    const fixture = await newFixture();

    await expect(store.create(quoteFor(fixture, { lineItems: [] }))).rejects.toThrow();
  });

  it('refuses to delete a category version a quote was priced under', async () => {
    const fixture = await newFixture();
    await store.create(quoteFor(fixture));

    /*
     * `ON DELETE RESTRICT`, and a real guard rather than a formality:
     * `category_versions` refuses UPDATE by trigger but deliberately still
     * permits DELETE (slice 2.1), so without this a price could lose the
     * configuration that explains it.
     */
    await expect(
      client.categoryVersion.delete({ where: { id: fixture.categoryVersionId } }),
    ).rejects.toThrow();
  });
});

describe('what a deletion takes with it', () => {
  it('deletes a listing’s quotes with the listing', async () => {
    const fixture = await newFixture();
    const created = await store.create(quoteFor(fixture));

    await client.listing.delete({ where: { id: fixture.listingId } });

    expect(await store.findForRenter(created.id, fixture.renterId)).toBe(null);
  });

  it('erases a renter’s quotes on request, and is idempotent', async () => {
    // **Erasure has to be explicit even though the foreign key cascades**:
    // accounts are soft-deleted (ADR 0018), so the `users` row survives and the
    // cascade never fires. This is the method §10.1 relies on.
    const fixture = await newFixture();
    await store.create(quoteFor(fixture));
    await store.create(
      quoteFor(fixture, { expiresAt: new Date('2026-09-10T13:00:00Z') }),
    );

    expect(await store.deleteAllForRenter(fixture.renterId)).toBe(2);
    expect(await store.deleteAllForRenter(fixture.renterId)).toBe(0);
  });

  it('leaves another renter’s quotes alone', async () => {
    const fixture = await newFixture();
    const other = await newUser();
    await store.create(quoteFor(fixture));
    const theirs = await store.create(quoteFor(fixture, { renterId: other }));

    await store.deleteAllForRenter(fixture.renterId);

    expect(await store.findForRenter(theirs.id, other)).not.toBe(null);
  });
});

describe('reading a quote back', () => {
  it('answers null for another renter’s quote', async () => {
    const fixture = await newFixture();
    const created = await store.create(quoteFor(fixture));
    const other = await newUser();

    // Scoped in the query, not compared afterwards — so "not yours" and "no
    // such quote" are one answer.
    expect(await store.findForRenter(created.id, other)).toBe(null);
  });

  it('answers null for a quote that does not exist', async () => {
    const fixture = await newFixture();

    expect(await store.findForRenter(randomUUID(), fixture.renterId)).toBe(null);
  });
});
