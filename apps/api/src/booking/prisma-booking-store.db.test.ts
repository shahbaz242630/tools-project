/**
 * The overlap constraint against a real PostgreSQL (slice 4.2).
 *
 * Needs `pnpm db:up` and migrations applied to the test database.
 *
 * **This file carries the first clause of Phase 4's exit gate** — *"two
 * simultaneous acceptances cannot reserve the same listing and period"* — and
 * §8.5.1 asks for it in those words: an alternative mechanism may be
 * substituted only *"evidenced by a test that issues simultaneous
 * acceptances"*. We did not substitute one, and the test exists anyway,
 * because a constraint nobody has watched refuse a race is a constraint nobody
 * has tested.
 *
 * **Nothing here can be proved by the in-memory fake and the fake says so.**
 * The guarantee is about two transactions in flight at once. An array cannot
 * exhibit that at all.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BookingState } from '@platform/contracts';
import { BOOKING_STATES } from '@platform/contracts';
import { PrismaCategoryStore } from '../catalogue/prisma-category-store.js';
import { PrismaListingStore } from '../catalogue/prisma-listing-store.js';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { CALENDAR_OCCUPYING_STATES } from './booking-state-machine.js';
import { OverlappingBookingError } from './booking-store.js';
import { PrismaBookingStore } from './prisma-booking-store.js';
import { DEFAULT_MAXIMUM_RENTAL_DAYS } from '@platform/contracts';

const env = loadEnv();

const connectionString = buildPostgresUrl({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_TEST_DB,
});

const client = createPrismaClient({ connectionString });
const categories = new PrismaCategoryStore(client);
const listings = new PrismaListingStore(
  client,
  createFieldEncryptor(Buffer.alloc(32, 7).toString('base64')),
);
const store = new PrismaBookingStore(client);

/** Any two instants; the calendar arithmetic is 4.4's, not this slice's. */
const MONDAY = new Date('2026-09-07T09:00:00Z');
const WEDNESDAY = new Date('2026-09-09T09:00:00Z');
const FRIDAY = new Date('2026-09-11T09:00:00Z');
const SUNDAY = new Date('2026-09-13T09:00:00Z');

beforeEach(async () => {
  /*
   * **Children before parents, and the list is the whole list rather than the
   * tables this file happens to write.** The first version truncated only
   * bookings, listings, categories and users — which passed inside a full
   * sequential run and failed the moment this file ran on its own after
   * another, because a `feature_flag_overrides` row left by a different suite
   * blocks `users` through an `ON DELETE RESTRICT`. A file that deletes users
   * has to be able to delete users.
   */
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
    collectionLocation: {
      line1: '14 Ashley Down Road',
      line2: null,
      town: 'Bristol',
      postcode: 'BS7 8AA',
    },
    locatedPoint: null,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
    categoryVersionNumber: 1,
  });

  return listing.id;
}

function booking(
  listingId: string,
  renterId: string,
  over: Partial<{ state: BookingState; startAt: Date; endAt: Date }> = {},
) {
  return {
    listingId,
    renterId,
    state: 'RESERVED' as BookingState,
    startAt: MONDAY,
    endAt: FRIDAY,
    timeZone: 'Europe/London',
    ...over,
  };
}

describe('the overlap constraint (BRD §8.5.1)', () => {
  it('refuses a second booking over the same period', async () => {
    const listingId = await newListing();

    await store.create(booking(listingId, await newUser()));

    await expect(
      store.create(booking(listingId, await newUser())),
    ).rejects.toBeInstanceOf(OverlappingBookingError);
  });

  it('refuses one that merely overlaps at an edge', async () => {
    const listingId = await newListing();

    await store.create(booking(listingId, await newUser()));

    await expect(
      store.create(
        booking(listingId, await newUser(), { startAt: WEDNESDAY, endAt: SUNDAY }),
      ),
    ).rejects.toBeInstanceOf(OverlappingBookingError);
  });

  /*
   * **`[)` — the range bound, as a test.** A hire ending at 09:00 Friday and one
   * starting at 09:00 Friday do not overlap, because the item changes hands. With
   * `[]` this would be refused and an owner could not let two people hire the
   * same tool on consecutive days, which is the ordinary case rather than an
   * edge one.
   */
  it('permits one that starts exactly as another ends', async () => {
    const listingId = await newListing();

    await store.create(booking(listingId, await newUser()));

    await expect(
      store.create(
        booking(listingId, await newUser(), { startAt: FRIDAY, endAt: SUNDAY }),
      ),
    ).resolves.toMatchObject({ listingId });
  });

  it('permits the same period against a different listing', async () => {
    const renter = await newUser();

    await store.create(booking(await newListing(), renter));

    await expect(
      store.create(booking(await newListing(), renter)),
    ).resolves.toBeDefined();
  });

  /*
   * **§7.1's central design, proved rather than described.** Several renters may
   * hold a request against the same listing and the same dates; none of them
   * reserves anything. A `REQUESTED` booking that blocked the calendar would let
   * the first person to click decide who gets the item instead of the owner.
   */
  it('lets any number of REQUESTED bookings share a period', async () => {
    const listingId = await newListing();

    for (let i = 0; i < 3; i++) {
      await store.create(booking(listingId, await newUser(), { state: 'REQUESTED' }));
    }

    expect(await client.booking.count({ where: { listingId } })).toBe(3);
  });

  /*
   * **Every one of §8.5.1's nine blocks, and nothing else does.** Generated from
   * `CALENDAR_OCCUPYING_STATES` rather than listed again, so the constraint's
   * `WHERE` clause and slice 4.1's set cannot drift apart — they are duplicated
   * across SQL and TypeScript by necessity, and this is what makes that safe.
   */
  it.each(BOOKING_STATES)(
    'a %s booking blocks only if §8.5.1 says so',
    async (state) => {
      const listingId = await newListing();

      await store.create(booking(listingId, await newUser(), { state }));

      const second = store.create(booking(listingId, await newUser()));

      if (CALENDAR_OCCUPYING_STATES.includes(state)) {
        await expect(second).rejects.toBeInstanceOf(OverlappingBookingError);
      } else {
        await expect(second).resolves.toBeDefined();
      }
    },
  );

  /*
   * **The constraint's own definition, read back from the catalogue.** The nine
   * states are written twice — in the migration's SQL and in
   * `booking-state-machine.ts` — because SQL cannot import TypeScript. This is
   * what stops the two drifting: it compares the list Postgres is actually
   * enforcing against the list the application believes in.
   */
  it('enforces exactly the states slice 4.1 declares', async () => {
    const [row] = await client.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'booking_periods_do_not_overlap'
    `;

    expect(row?.definition).toBeDefined();
    const enforced = BOOKING_STATES.filter((state) =>
      row?.definition.includes(`'${state}'`),
    );

    expect([...enforced].sort()).toEqual([...CALENDAR_OCCUPYING_STATES].sort());
  });
});

/**
 * **The exit gate's first clause**, and the reason §8.5.1 forbids
 * check-then-insert: *"racy under concurrency"*.
 */
describe('two acceptances at once', () => {
  it('lets exactly one win', async () => {
    const listingId = await newListing();
    const [alice, bob] = [await newUser(), await newUser()];

    /*
     * **Two separate clients, so these are genuinely two connections.** Issuing
     * both through one Prisma client would serialise them in the pool and prove
     * nothing about concurrency — the failure would look like a pass. Each opens
     * its own transaction, and both are in flight before either commits.
     */
    const one = createPrismaClient({ connectionString });
    const two = createPrismaClient({ connectionString });

    try {
      const results = await Promise.allSettled([
        new PrismaBookingStore(one).create(booking(listingId, alice)),
        new PrismaBookingStore(two).create(booking(listingId, bob)),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');

      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      // The loser is told it is a conflict rather than a database failure —
      // which is what lets slice 4.6 auto-decline per §7.1 instead of 500ing.
      expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        OverlappingBookingError,
      );

      // And the database agrees, which is the assertion that would catch a
      // constraint that let both through and an error thrown for another reason.
      expect(await client.booking.count({ where: { listingId } })).toBe(1);
    } finally {
      await one.$disconnect();
      await two.$disconnect();
    }
  });
});

/**
 * **The finding this slice's concurrency test produced**, pinned so that the
 * retry in `PrismaBookingStore.create` cannot be tidied away by somebody who
 * reads it as defensive noise.
 *
 * Two inserts racing on an exclusion constraint do **not** reliably produce
 * `23P01`. Neither transaction can decide whether it conflicts until the other
 * commits, so each takes a `ShareLock` on the other and Postgres reports
 * **`40P01` deadlock detected** — about one race in three, measured. The
 * constraint still holds; the *error* is the problem, because slice 4.6 has to
 * tell a conflict from a database failure in order to auto-decline per §7.1
 * rather than return a 500.
 */
describe('racing repeatedly', () => {
  it('always reports a conflict, never a deadlock', async () => {
    const listingId = await newListing();
    const renter = await newUser();

    /*
     * **Ten rounds, because one is not evidence.** The bug this guards was
     * intermittent at roughly one in three, so a single race passes more often
     * than it fails and a single-round test would have shipped it. Each round
     * clears the table so every attempt is a genuine two-way race rather than
     * the second one losing to a row that is already there.
     */
    for (let round = 0; round < 10; round++) {
      await client.booking.deleteMany({ where: { listingId } });

      const one = createPrismaClient({ connectionString });
      const two = createPrismaClient({ connectionString });

      try {
        const results = await Promise.allSettled([
          new PrismaBookingStore(one).create(booking(listingId, renter)),
          new PrismaBookingStore(two).create(booking(listingId, renter)),
        ]);

        const rejected = results.filter((r) => r.status === 'rejected');
        for (const failure of rejected) {
          expect(
            (failure as PromiseRejectedResult).reason,
            `round ${String(round)} leaked a raw database error`,
          ).toBeInstanceOf(OverlappingBookingError);
        }

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      } finally {
        await one.$disconnect();
        await two.$disconnect();
      }
    }
  }, 60_000);
});

describe('the period column', () => {
  it('is derived on insert, never written by the application', async () => {
    const listingId = await newListing();
    const created = await store.create(booking(listingId, await newUser()));

    const [row] = await client.$queryRaw<{ period: string }[]>`
      SELECT "period"::text AS period FROM "bookings" WHERE "id" = ${created.id}::uuid
    `;

    // `[)` in the stored value itself, which is where the bound actually lives.
    expect(row?.period).toContain('[');
    expect(row?.period).toContain(')');
  });

  /*
   * **The failure this guards is the quiet one**: a booking whose dates were
   * edited keeps holding the period it used to have, so the calendar protects
   * the wrong week and nothing reports it. The trigger fires on UPDATE OF the
   * two bounds, and this is what says so.
   */
  it('follows an edit to the dates', async () => {
    const listingId = await newListing();
    const first = await store.create(booking(listingId, await newUser()));

    await client.booking.update({
      where: { id: first.id },
      data: { startAt: FRIDAY, endAt: SUNDAY },
    });

    // The old period is free again…
    await expect(
      store.create(booking(listingId, await newUser())),
    ).resolves.toBeDefined();
    // …and the new one is taken.
    await expect(
      store.create(
        booking(listingId, await newUser(), { startAt: FRIDAY, endAt: SUNDAY }),
      ),
    ).rejects.toBeInstanceOf(OverlappingBookingError);
  });

  it('refuses a booking that ends before it starts', async () => {
    const listingId = await newListing();

    await expect(
      store.create(
        booking(listingId, await newUser(), { startAt: FRIDAY, endAt: MONDAY }),
      ),
    ).rejects.toThrow();
  });

  /*
   * **A zero-length booking is refused rather than stored holding nothing.**
   * `tstzrange(x, x, '[)')` is `empty`, and `empty && anything` is false — so
   * without the CHECK this row would sit in a blocking state while occupying no
   * dates at all, which is the most confusing possible state for a calendar to
   * be in.
   */
  it('refuses a booking with no duration', async () => {
    const listingId = await newListing();

    await expect(
      store.create(
        booking(listingId, await newUser(), { startAt: MONDAY, endAt: MONDAY }),
      ),
    ).rejects.toThrow();
  });
});

describe('which listings are booked', () => {
  it('names only the ones a booking refers to', async () => {
    const booked = await newListing();
    const free = await newListing();
    await store.create(booking(booked, await newUser()));

    const referenced = await store.findBookedListings([booked, free]);

    expect([...referenced]).toEqual([booked]);
  });

  /*
   * **Every state counts, including the ones that went nowhere.** A declined
   * request is still a record of somebody having asked, and narrowing this to
   * live bookings would delete a listing out from under a renter's history —
   * which is the §10.1 carve-out this port exists to serve.
   */
  it('counts a booking in any state, not only a live one', async () => {
    const listingId = await newListing();
    await store.create(booking(listingId, await newUser(), { state: 'DECLINED' }));

    expect([...(await store.findBookedListings([listingId]))]).toEqual([listingId]);
  });

  it('answers an empty question without going to the database', async () => {
    expect([...(await store.findBookedListings([]))]).toEqual([]);
  });

  it('reports each listing once however many bookings it has', async () => {
    const listingId = await newListing();
    await store.create(booking(listingId, await newUser(), { state: 'REQUESTED' }));
    await store.create(booking(listingId, await newUser(), { state: 'REQUESTED' }));

    expect([...(await store.findBookedListings([listingId]))]).toHaveLength(1);
  });
});
