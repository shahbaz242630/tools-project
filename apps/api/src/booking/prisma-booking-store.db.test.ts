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
import type { NewBooking } from './booking-store.js';
import { PrismaBookingStore } from './prisma-booking-store.js';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  DEFAULT_REQUEST_EXPIRY_HOURS,
} from '@platform/contracts';

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
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
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

/**
 * A booking to write, with the terms slice 4.5a made required.
 *
 * **Asynchronous from 4.5a, because a booking now needs a quote.** `NewBooking`
 * carries the money, the item's name and the configuration version it was made
 * under (§8.2), and the quote is where all of that legitimately comes from — so
 * the fixture writes one rather than inventing amounts, and a booking with no
 * provable price stays unrepresentable in tests as well as in the schema.
 */
async function booking(
  listingId: string,
  renterId: string,
  over: Partial<{ state: BookingState; startAt: Date; endAt: Date }> = {},
): Promise<NewBooking> {
  const startAt = over.startAt ?? MONDAY;
  const endAt = over.endAt ?? FRIDAY;

  /*
   * **The quote keeps a valid period even when the booking under test does not.**
   * Two tests here deliberately build an inverted or empty period to prove the
   * *booking's* CHECK refuses it — and `quotes` carries the same constraint, so a
   * quote copying those dates would fail first and the test would prove the wrong
   * table. In production the two always match, because the booking copies the
   * quote; here the quote is scaffolding, and scaffolding that cannot be built
   * hides the thing it holds up.
   */
  const quotePeriod =
    endAt.getTime() > startAt.getTime()
      ? { startAt, endAt }
      : { startAt: MONDAY, endAt: FRIDAY };

  const version = await client.categoryVersion.findFirstOrThrow({
    where: { listings: { some: { id: listingId } } },
  });

  const quote = await client.quote.create({
    data: {
      listingId,
      renterId,
      startAt: quotePeriod.startAt,
      endAt: quotePeriod.endAt,
      timeZone: 'Europe/London',
      renterPostcode: 'BS7 8AA',
      itemChargeAmount: 5_400,
      renterFeeAmount: 432,
      totalAmount: 5_832,
      currency: 'GBP',
      minimumFeeApplied: false,
      lineItems: [
        {
          unit: 'day',
          count: 3,
          unitPrice: { amount: 1_800, currency: 'GBP' },
          subtotal: { amount: 5_400, currency: 'GBP' },
        },
      ],
      categoryVersionId: version.id,
      expiresAt: new Date(quotePeriod.startAt.getTime() + 30 * 60_000),
    },
  });

  return {
    listingId,
    renterId,
    state: 'RESERVED' as BookingState,
    startAt,
    endAt,
    timeZone: 'Europe/London',
    quoteId: quote.id,
    categoryVersionId: version.id,
    itemCharge: { amount: 5_400, currency: 'GBP' },
    renterFee: { amount: 432, currency: 'GBP' },
    total: { amount: 5_832, currency: 'GBP' },
    itemTitle: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    requestExpiresAt: new Date(startAt.getTime() + 48 * 3_600_000),
    ...over,
  };
}

describe('the overlap constraint (BRD §8.5.1)', () => {
  it('refuses a second booking over the same period', async () => {
    const listingId = await newListing();

    await store.create(await booking(listingId, await newUser()));

    await expect(
      store.create(await booking(listingId, await newUser())),
    ).rejects.toBeInstanceOf(OverlappingBookingError);
  });

  it('refuses one that merely overlaps at an edge', async () => {
    const listingId = await newListing();

    await store.create(await booking(listingId, await newUser()));

    await expect(
      store.create(
        await booking(listingId, await newUser(), {
          startAt: WEDNESDAY,
          endAt: SUNDAY,
        }),
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

    await store.create(await booking(listingId, await newUser()));

    await expect(
      store.create(
        await booking(listingId, await newUser(), { startAt: FRIDAY, endAt: SUNDAY }),
      ),
    ).resolves.toMatchObject({ listingId });
  });

  it('permits the same period against a different listing', async () => {
    const renter = await newUser();

    await store.create(await booking(await newListing(), renter));

    await expect(
      store.create(await booking(await newListing(), renter)),
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
      await store.create(
        await booking(listingId, await newUser(), { state: 'REQUESTED' }),
      );
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

      await store.create(await booking(listingId, await newUser(), { state }));

      const second = store.create(await booking(listingId, await newUser()));

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
        new PrismaBookingStore(one).create(await booking(listingId, alice)),
        new PrismaBookingStore(two).create(await booking(listingId, bob)),
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
          new PrismaBookingStore(one).create(await booking(listingId, renter)),
          new PrismaBookingStore(two).create(await booking(listingId, renter)),
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
    const created = await store.create(await booking(listingId, await newUser()));

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
    const first = await store.create(await booking(listingId, await newUser()));

    await client.booking.update({
      where: { id: first.id },
      data: { startAt: FRIDAY, endAt: SUNDAY },
    });

    // The old period is free again…
    await expect(
      store.create(await booking(listingId, await newUser())),
    ).resolves.toBeDefined();
    // …and the new one is taken.
    await expect(
      store.create(
        await booking(listingId, await newUser(), { startAt: FRIDAY, endAt: SUNDAY }),
      ),
    ).rejects.toBeInstanceOf(OverlappingBookingError);
  });

  it('refuses a booking that ends before it starts', async () => {
    const listingId = await newListing();

    await expect(
      store.create(
        await booking(listingId, await newUser(), { startAt: FRIDAY, endAt: MONDAY }),
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
        await booking(listingId, await newUser(), { startAt: MONDAY, endAt: MONDAY }),
      ),
    ).rejects.toThrow();
  });
});

describe('which listings are booked', () => {
  it('names only the ones a booking refers to', async () => {
    const booked = await newListing();
    const free = await newListing();
    await store.create(await booking(booked, await newUser()));

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
    await store.create(
      await booking(listingId, await newUser(), { state: 'DECLINED' }),
    );

    expect([...(await store.findBookedListings([listingId]))]).toEqual([listingId]);
  });

  it('answers an empty question without going to the database', async () => {
    expect([...(await store.findBookedListings([]))]).toEqual([]);
  });

  it('reports each listing once however many bookings it has', async () => {
    const listingId = await newListing();
    await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    expect([...(await store.findBookedListings([listingId]))]).toHaveLength(1);
  });
});

describe('the booking a request creates (slice 4.5a)', () => {
  it('writes the terms and reads them back with their currency', async () => {
    const listingId = await newListing();
    const toWrite = await booking(listingId, await newUser(), { state: 'REQUESTED' });

    const created = await store.createWithEvent(toWrite, {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      actorId: toWrite.renterId,
      metadata: {},
    });

    const read = await store.findForParty(created.id, toWrite.renterId);

    expect(read?.booking.total).toEqual({ amount: 5_832, currency: 'GBP' });
    expect(read?.booking.itemTitle).toBe('Petrol hedge trimmer');
    expect(read?.booking.categoryName).toBe('Outdoor and gardening');
    expect(read?.booking.quoteId).toBe(toWrite.quoteId);
  });

  it('writes the first event in the same transaction', async () => {
    const listingId = await newListing();
    const toWrite = await booking(listingId, await newUser(), { state: 'REQUESTED' });

    const created = await store.createWithEvent(toWrite, {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      actorId: toWrite.renterId,
      metadata: { source: 'test' },
    });

    const read = await store.findForParty(created.id, toWrite.renterId);

    expect(read?.events).toHaveLength(1);
    expect(read?.events[0]?.type).toBe('requested');
    expect(read?.events[0]?.fromState).toBe(null);
    expect(read?.events[0]?.toState).toBe('REQUESTED');
    expect(read?.events[0]?.metadata).toEqual({ source: 'test' });
  });

  it('leaves no event behind when the booking is refused', async () => {
    /*
     * **The one thing only this file can prove.** The in-memory fake writes the
     * event after a `create` that either threw or did not, so it cannot exhibit a
     * partial write at all — and a booking whose history begins with a gap is what
     * §6.2 forbids.
     */
    const listingId = await newListing();
    const held = await booking(listingId, await newUser());
    await store.create(held);

    const loser = await booking(listingId, await newUser());
    await expect(
      store.createWithEvent(loser, {
        type: 'requested',
        fromState: null,
        toState: 'REQUESTED',
        actorId: loser.renterId,
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(OverlappingBookingError);

    // One booking, one event — the loser's transaction took its event with it.
    expect(await client.bookingEvent.count()).toBe(0);
    expect(await client.booking.count()).toBe(1);
  });

  it('refuses to update an event, because §6.2 calls the history immutable', async () => {
    const listingId = await newListing();
    const toWrite = await booking(listingId, await newUser(), { state: 'REQUESTED' });
    const created = await store.createWithEvent(toWrite, {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      actorId: toWrite.renterId,
      metadata: {},
    });

    const event = await client.bookingEvent.findFirstOrThrow({
      where: { bookingId: created.id },
    });

    // The trigger, which is the only version of "immutable" that survives a
    // future writer who has not read the port.
    await expect(
      client.bookingEvent.update({
        where: { id: event.id },
        data: { toState: 'ACCEPTED' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('gives a booking to either party and to nobody else', async () => {
    const listingId = await newListing();
    const owner = await client.listing.findFirstOrThrow({ where: { id: listingId } });
    const toWrite = await booking(listingId, await newUser(), { state: 'REQUESTED' });
    const created = await store.createWithEvent(toWrite, {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      actorId: toWrite.renterId,
      metadata: {},
    });

    // The renter made it; the owner has to decide on it (§8.6); a stranger gets
    // the same answer as for a booking that does not exist.
    expect(await store.findForParty(created.id, toWrite.renterId)).not.toBeNull();
    expect(await store.findForParty(created.id, owner.ownerId)).not.toBeNull();
    expect(await store.findForParty(created.id, await newUser())).toBeNull();
  });

  it('brings the breakdown back from the quote the booking was made from', async () => {
    // §3.4.4 wants the total shown with its parts, and the parts live on the
    // quote. The `RESTRICT` on `bookings.quoteId` is what makes the join safe.
    const listingId = await newListing();
    const toWrite = await booking(listingId, await newUser(), { state: 'REQUESTED' });
    const created = await store.createWithEvent(toWrite, {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      actorId: toWrite.renterId,
      metadata: {},
    });

    const read = await store.findForParty(created.id, toWrite.renterId);

    expect(read?.lineItems).toEqual([
      {
        unit: 'day',
        count: 3,
        unitPrice: { amount: 1_800, currency: 'GBP' },
        subtotal: { amount: 5_400, currency: 'GBP' },
      },
    ]);
  });

  it('refuses to delete a quote a booking was made from', async () => {
    // The 17 August erasure decision, enforced by the constraint: the terms
    // belong to the counterparty too.
    const listingId = await newListing();
    const toWrite = await booking(listingId, await newUser(), { state: 'REQUESTED' });
    await store.create(toWrite);

    await expect(
      client.quote.delete({ where: { id: toWrite.quoteId } }),
    ).rejects.toThrow();
  });
});
