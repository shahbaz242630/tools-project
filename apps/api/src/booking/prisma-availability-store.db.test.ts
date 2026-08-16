/**
 * The owner's calendar against a real PostgreSQL (slice 4.3a).
 *
 * Needs `pnpm db:up` and migrations applied to the test database.
 *
 * **The one thing only this file can prove** is that the `[)` bound is stated
 * consistently in the two places it lives: the trigger that builds `period`,
 * and the `<`/`>` comparisons the adapter asks with. Everything else here is
 * arithmetic the in-memory fake models identically — which is why the fake says
 * so and this file exists anyway.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BookingState } from '@platform/contracts';
import { PrismaCategoryStore } from '../catalogue/prisma-category-store.js';
import { PrismaListingStore } from '../catalogue/prisma-listing-store.js';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { PrismaAvailabilityStore } from './prisma-availability-store.js';
import { PrismaBookingStore } from './prisma-booking-store.js';

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
const bookings = new PrismaBookingStore(client);
const store = new PrismaAvailabilityStore(client);

const MONDAY = new Date('2026-09-07T09:00:00Z');
const WEDNESDAY = new Date('2026-09-09T09:00:00Z');
const FRIDAY = new Date('2026-09-11T09:00:00Z');
const SUNDAY = new Date('2026-09-13T09:00:00Z');
const NEXT_FRIDAY = new Date('2026-09-18T09:00:00Z');

beforeEach(async () => {
  // Children before parents. Blocks cascade from listings, but truncating them
  // explicitly keeps this list readable as the order it actually is.
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

async function newListing(): Promise<string> {
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

  return listing.id;
}

async function givenABooking(
  listingId: string,
  state: BookingState,
  startAt = MONDAY,
  endAt = FRIDAY,
): Promise<void> {
  await bookings.create({
    listingId,
    renterId: await newUser(),
    state,
    startAt,
    endAt,
    timeZone: 'Europe/London',
  });
}

describe('declaring a period unavailable', () => {
  it('records what the owner said, including their note', async () => {
    const listingId = await newListing();

    const block = await store.block({
      listingId,
      startAt: MONDAY,
      endAt: FRIDAY,
      reason: 'Away that week',
    });

    expect(block).toMatchObject({ listingId, reason: 'Away that week' });
    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBe('blocked');
  });

  it('accepts a block with no note, because a reason is the owner’s business', async () => {
    const listingId = await newListing();

    await expect(
      store.block({ listingId, startAt: MONDAY, endAt: FRIDAY, reason: null }),
    ).resolves.toMatchObject({ reason: null });
  });

  /*
   * **Two overlapping blocks are fine, and this is the test that says so.**
   * There is no `EXCLUDE` constraint here on purpose: an owner who blocks a
   * fortnight and then blocks a week inside it has said the same thing twice,
   * and refusing the second would be a form error about nothing.
   */
  it('lets an owner block a period twice over', async () => {
    const listingId = await newListing();

    await store.block({ listingId, startAt: MONDAY, endAt: SUNDAY, reason: null });

    await expect(
      store.block({ listingId, startAt: WEDNESDAY, endAt: FRIDAY, reason: null }),
    ).resolves.toBeDefined();
  });

  /*
   * **Blocking dates that are already booked is redundant, not refused.** The
   * answer to "is this available" is no either way, and erroring would mean an
   * owner tidying their calendar is told about a booking they already know
   * about.
   */
  it('lets an owner block a period something is already booked for', async () => {
    const listingId = await newListing();
    await givenABooking(listingId, 'RESERVED');

    await expect(
      store.block({ listingId, startAt: MONDAY, endAt: FRIDAY, reason: null }),
    ).resolves.toBeDefined();
  });

  it('refuses a block that ends before it starts', async () => {
    const listingId = await newListing();

    await expect(
      store.block({ listingId, startAt: FRIDAY, endAt: MONDAY, reason: null }),
    ).rejects.toThrow();
  });

  it('refuses a block with no duration', async () => {
    const listingId = await newListing();

    await expect(
      store.block({ listingId, startAt: MONDAY, endAt: MONDAY, reason: null }),
    ).rejects.toThrow();
  });
});

describe('why a period is unavailable', () => {
  it('is nothing at all when the calendar is clear', async () => {
    const listingId = await newListing();

    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBeNull();
  });

  it('is booked when a booking holds it', async () => {
    const listingId = await newListing();
    await givenABooking(listingId, 'RESERVED');

    expect(await store.reasonUnavailable(listingId, WEDNESDAY, SUNDAY)).toBe('booked');
  });

  /*
   * **§7.1, as a calendar rule.** A request reserves nothing — several renters
   * may hold one against the same dates — so a `REQUESTED` booking must not
   * make a period unavailable. If it did, the first person to click would take
   * the item off the calendar without the owner agreeing to anything.
   */
  it('is not booked by a REQUESTED booking, which reserves nothing', async () => {
    const listingId = await newListing();
    await givenABooking(listingId, 'REQUESTED');

    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBeNull();
  });

  it('is not booked by a cancelled one either', async () => {
    const listingId = await newListing();
    await givenABooking(listingId, 'CANCELLED');

    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBeNull();
  });

  /*
   * **`blocked` wins when both are true**, and it is the answer the owner can
   * act on. Telling them "somebody has booked it" sends them looking for a
   * booking they cannot remove while their own block sits there.
   */
  it('says blocked rather than booked when it is both', async () => {
    const listingId = await newListing();
    await givenABooking(listingId, 'RESERVED');
    await store.block({ listingId, startAt: MONDAY, endAt: FRIDAY, reason: null });

    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBe('blocked');
  });

  /*
   * **`[)` again, and this is the assertion that ties the two statements of it
   * together.** The trigger builds `period` with an exclusive end; the adapter
   * asks with `<` and `>`. A period starting exactly as a block ends is free.
   */
  it('leaves a period starting exactly as a block ends available', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: MONDAY, endAt: FRIDAY, reason: null });

    expect(await store.reasonUnavailable(listingId, FRIDAY, SUNDAY)).toBeNull();
  });

  it('leaves a period ending exactly as a block starts available', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: FRIDAY, endAt: SUNDAY, reason: null });

    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBeNull();
  });

  it('catches a period wholly inside a block', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: MONDAY, endAt: SUNDAY, reason: null });

    expect(await store.reasonUnavailable(listingId, WEDNESDAY, FRIDAY)).toBe('blocked');
  });

  it('catches a block wholly inside the period asked about', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: WEDNESDAY, endAt: FRIDAY, reason: null });

    expect(await store.reasonUnavailable(listingId, MONDAY, SUNDAY)).toBe('blocked');
  });

  it('says nothing about another listing’s calendar', async () => {
    const mine = await newListing();
    const theirs = await newListing();
    await store.block({
      listingId: theirs,
      startAt: MONDAY,
      endAt: FRIDAY,
      reason: null,
    });

    expect(await store.reasonUnavailable(mine, MONDAY, FRIDAY)).toBeNull();
  });
});

describe('reading the calendar', () => {
  /*
   * **Blocks that *touch* the window, not blocks contained by it.** A
   * fortnight's block seen through a one-week view has neither end inside the
   * window, and the obvious query would draw that week as free — which is the
   * defect this test exists for.
   */
  it('includes a block that spans the whole window', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: MONDAY, endAt: NEXT_FRIDAY, reason: null });

    const blocks = await store.listBlocks(listingId, WEDNESDAY, FRIDAY);

    expect(blocks).toHaveLength(1);
  });

  it('returns them in date order', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: FRIDAY, endAt: SUNDAY, reason: 'second' });
    await store.block({
      listingId,
      startAt: MONDAY,
      endAt: WEDNESDAY,
      reason: 'first',
    });

    const blocks = await store.listBlocks(listingId, MONDAY, NEXT_FRIDAY);

    expect(blocks.map((block) => block.reason)).toEqual(['first', 'second']);
  });

  it('leaves out blocks outside the window entirely', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: SUNDAY, endAt: NEXT_FRIDAY, reason: null });

    expect(await store.listBlocks(listingId, MONDAY, WEDNESDAY)).toEqual([]);
  });

  it('leaves out another listing’s blocks', async () => {
    const mine = await newListing();
    const theirs = await newListing();
    await store.block({
      listingId: theirs,
      startAt: MONDAY,
      endAt: FRIDAY,
      reason: null,
    });

    expect(await store.listBlocks(mine, MONDAY, NEXT_FRIDAY)).toEqual([]);
  });
});

describe('removing a block', () => {
  it('removes it and says so', async () => {
    const listingId = await newListing();
    const block = await store.block({
      listingId,
      startAt: MONDAY,
      endAt: FRIDAY,
      reason: null,
    });

    expect(await store.unblock(block.id, listingId)).toBe(true);
    expect(await store.reasonUnavailable(listingId, MONDAY, FRIDAY)).toBeNull();
  });

  /*
   * **"Not yours" and "already gone" are the same answer**, deliberately. A
   * caller that could tell them apart could ask this endpoint whether a block id
   * exists on somebody else's listing.
   */
  it('reports nothing removed for another listing’s block', async () => {
    const mine = await newListing();
    const theirs = await newListing();
    const block = await store.block({
      listingId: theirs,
      startAt: MONDAY,
      endAt: FRIDAY,
      reason: null,
    });

    expect(await store.unblock(block.id, mine)).toBe(false);
    // And it is still there, which is the half that would otherwise be a
    // cross-account delete.
    expect(await store.reasonUnavailable(theirs, MONDAY, FRIDAY)).toBe('blocked');
  });

  it('reports nothing removed for an id that never existed', async () => {
    const listingId = await newListing();

    expect(await store.unblock(randomUUID(), listingId)).toBe(false);
  });
});

/*
 * **A block belongs to the owner, so it goes when the listing does.** The
 * opposite choice from `bookings`, which survive because they are somebody
 * else's record — and slice 4.2's erasure keeps a booked listing alive
 * precisely for that reason. This asserts the cascade rather than trusting the
 * schema annotation.
 */
describe('when the listing goes', () => {
  it('takes the owner’s blocks with it', async () => {
    const listingId = await newListing();
    await store.block({ listingId, startAt: MONDAY, endAt: FRIDAY, reason: null });

    await client.listing.delete({ where: { id: listingId } });

    expect(await client.availabilityBlock.count({ where: { listingId } })).toBe(0);
  });
});
