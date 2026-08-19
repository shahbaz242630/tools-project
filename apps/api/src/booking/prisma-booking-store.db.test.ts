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
import {
  BookingStateChangedError,
  DuplicateQuoteBookingError,
  OverlappingBookingError,
} from './booking-store.js';
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
  over: Partial<{
    state: BookingState;
    startAt: Date;
    endAt: Date;
    /** Overridable from slice 4.7a, where the deadline is the thing under test. */
    requestExpiresAt: Date;
    /** Overridable from slice 4.7a, to prove one quote cannot make two bookings. */
    quoteId: string;
  }> = {},
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

/** Who owns a listing `newListing()` made, which it does not hand back. */
async function ownerOf(listingId: string): Promise<string> {
  const listing = await client.listing.findFirstOrThrow({ where: { id: listingId } });
  return listing.ownerId;
}

const LATER = new Date('2026-09-01T09:00:00Z');

describe('accepting a request (§7.1, slice 4.6)', () => {
  it('locks the dates and auto-declines every overlapping request', async () => {
    /*
     * §7.1 in one test: *"move the accepted booking to `ACCEPTED`; and move every
     * other `REQUESTED` booking whose dates overlap the accepted period to
     * `DECLINED` with reason `AUTO_DECLINED_CONFLICT`."*
     */
    const listingId = await newListing();
    const owner = await ownerOf(listingId);

    const winner = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    const overlapping = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        startAt: WEDNESDAY,
        endAt: SUNDAY,
      }),
    );
    // Starts exactly where the winner ends. `[)` says these do not touch, so it
    // must survive — the assertion that would catch an overlap rule using `<=`.
    const adjacent = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        startAt: FRIDAY,
        endAt: SUNDAY,
      }),
    );

    const result = await store.accept(winner.id, owner, LATER);

    expect(result?.booking.state).toBe('ACCEPTED');
    expect(result?.autoDeclinedIds).toEqual([overlapping.id]);

    const states = await client.booking.findMany({
      where: { listingId },
      select: { id: true, state: true },
    });
    expect(new Map(states.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [winner.id, 'ACCEPTED'],
        [overlapping.id, 'DECLINED'],
        [adjacent.id, 'REQUESTED'],
      ]),
    );
  });

  it('records the auto-decline as its own event type, with the reason', async () => {
    /*
     * **The reason has to reach the losing renter, and only the *type* can carry
     * it.** `bookingEventSchema` does not project `metadata` to a party, so an
     * auto-decline written as an ordinary `state-changed` would read to them as
     * "the owner said no" — which is not what happened, and not what §7.1 requires
     * them to be told.
     */
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const winner = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    const loser = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    await store.accept(winner.id, owner, LATER);

    const [event] = await client.bookingEvent.findMany({
      where: { bookingId: loser.id },
    });
    expect(event?.type).toBe('auto-declined');
    expect(event?.fromState).toBe('REQUESTED');
    expect(event?.toState).toBe('DECLINED');
    // Nobody decided it, so nobody is named. §6.2's actor is null for the platform.
    expect(event?.actorId).toBeNull();
    expect(event?.metadata).toMatchObject({
      reason: 'AUTO_DECLINED_CONFLICT',
      conflictingBookingId: winner.id,
    });
  });

  it("writes the acceptance into the booking's own history", async () => {
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const request = await store.createWithEvent(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
      {
        type: 'requested',
        fromState: null,
        toState: 'REQUESTED',
        actorId: null,
        metadata: {},
      },
    );

    await store.accept(request.id, owner, LATER);

    const events = await client.bookingEvent.findMany({
      where: { bookingId: request.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      [null, 'REQUESTED'],
      ['REQUESTED', 'ACCEPTED'],
    ]);
    // The owner decided this one, unlike the auto-decline above.
    expect(events[1]?.actorId).toBe(owner);
  });

  it("refuses a booking that is not this owner's, without saying so", async () => {
    const listingId = await newListing();
    const request = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    // Null rather than a throw: "not yours" and "no such booking" are one answer,
    // so nobody learns a booking id is real by guessing at it.
    expect(await store.accept(request.id, await newUser(), LATER)).toBeNull();
    expect(await store.accept(randomUUID(), await newUser(), LATER)).toBeNull();
  });

  it('refuses a request that has already been answered', async () => {
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const request = await store.create(
      await booking(listingId, await newUser(), { state: 'DECLINED' }),
    );

    await expect(store.accept(request.id, owner, LATER)).rejects.toBeInstanceOf(
      BookingStateChangedError,
    );
  });

  it('leaves nothing behind when the dates were taken first', async () => {
    /*
     * **The transaction, proved rather than asserted.** A losing acceptance must
     * roll back its own event *and* every auto-decline it had already written —
     * which is the one thing the in-memory fake structurally cannot show.
     */
    const listingId = await newListing();
    const owner = await ownerOf(listingId);

    await store.create(
      await booking(listingId, await newUser(), { state: 'RESERVED' }),
    );
    const doomed = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    const bystander = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    await expect(store.accept(doomed.id, owner, LATER)).rejects.toBeInstanceOf(
      OverlappingBookingError,
    );

    // Both still requests, and no event was written for either.
    const after = await client.booking.findMany({
      where: { id: { in: [doomed.id, bystander.id] } },
      select: { state: true },
    });
    expect(after.map((row) => row.state)).toEqual(['REQUESTED', 'REQUESTED']);
    expect(
      await client.bookingEvent.count({
        where: { bookingId: { in: [doomed.id, bystander.id] } },
      }),
    ).toBe(0);
  });
});

describe('two acceptances at once (Phase 4 exit gate)', () => {
  it('lets exactly one win, and declines the loser', async () => {
    /*
     * **The exit gate in its own words** — *"two simultaneous acceptances cannot
     * reserve the same listing and period"*. 4.2 proved it for two *creations*
     * already in occupying states; this proves it for the thing the gate names,
     * which is two owners' clicks arriving at once on two live requests.
     *
     * Two Prisma clients, so these are genuinely two connections: one client
     * would serialise them in the pool and the failure would look like a pass.
     */
    const listingId = await newListing();
    const owner = await ownerOf(listingId);

    const first = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    const second = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    const one = createPrismaClient({ connectionString });
    const two = createPrismaClient({ connectionString });

    try {
      const results = await Promise.allSettled([
        new PrismaBookingStore(one).accept(first.id, owner, LATER),
        new PrismaBookingStore(two).accept(second.id, owner, LATER),
      ]);

      /*
       * **One of three shapes is acceptable, and all three mean the same thing.**
       * The loser either loses the constraint race (`OverlappingBookingError`) or
       * arrives after the winner's auto-decline has already moved it out of
       * `REQUESTED` (`BookingStateChangedError`). What must never happen is both
       * succeeding.
       */
      const won = results.filter(
        (result) => result.status === 'fulfilled' && result.value !== null,
      );
      expect(won).toHaveLength(1);

      const occupying = await client.booking.findMany({
        where: { listingId, state: { in: [...CALENDAR_OCCUPYING_STATES] } },
      });
      expect(occupying).toHaveLength(1);
    } finally {
      await one.$disconnect();
      await two.$disconnect();
    }
  });
});

describe('the requests waiting on an owner (slice 4.6)', () => {
  it('offers only live requests, and counts what each would displace', async () => {
    const listingId = await newListing();
    const owner = await ownerOf(listingId);

    const first = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    const overlapping = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        startAt: WEDNESDAY,
        endAt: SUNDAY,
      }),
    );
    // Answered already, so not waiting on anybody.
    await store.create(
      await booking(listingId, await newUser(), { state: 'DECLINED' }),
    );

    const pending = await store.findPendingRequests(listingId, owner, LATER);

    expect(pending.map((request) => request.booking.id)).toEqual([
      first.id,
      overlapping.id,
    ]);
    // §7.1: the owner must be shown that accepting either declines the other.
    expect(pending.map((request) => request.conflictCount)).toEqual([1, 1]);
  });

  it('does not offer a request whose deadline has passed', async () => {
    // §8.6 gives a request a deadline. Offering an expired one as acceptable
    // would be the deadline not existing — 4.7's worker does not exist yet.
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    const wellAfterTheDeadline = new Date('2027-01-01T00:00:00Z');
    expect(
      await store.findPendingRequests(listingId, owner, wellAfterTheDeadline),
    ).toEqual([]);
  });

  it("tells a stranger nothing about somebody else's listing", async () => {
    const listingId = await newListing();
    await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    // Empty rather than forbidden, so the id is not confirmed to exist.
    expect(await store.findPendingRequests(listingId, await newUser(), LATER)).toEqual(
      [],
    );
  });
});

describe('declining a request (slice 4.6)', () => {
  it('moves it out of REQUESTED and says who did it', async () => {
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const request = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    const declined = await store.decline(request.id, owner, LATER);

    expect(declined?.state).toBe('DECLINED');
    const [event] = await client.bookingEvent.findMany({
      where: { bookingId: request.id },
    });
    // `state-changed`, not `auto-declined`: a person decided this one, and the
    // renter is owed the difference.
    expect(event?.type).toBe('state-changed');
    expect(event?.actorId).toBe(owner);
  });

  it('frees nothing, so a later acceptance of the same dates still works', async () => {
    // The asymmetry between the two decisions, made visible: declining releases
    // no lock because a request never held one (§7.1).
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const first = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );
    const second = await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    await store.decline(first.id, owner, LATER);
    const accepted = await store.accept(second.id, owner, LATER);

    expect(accepted?.booking.state).toBe('ACCEPTED');
    expect(accepted?.autoDeclinedIds).toEqual([]);
  });
});

/**
 * Slice 4.7a. Two guarantees only a database can give.
 *
 * `OVERDUE` and `SWEEP_AT` are a pair: a deadline in the past relative to the
 * instant the sweep is told is *now*. Both are fixed, so nothing here depends on
 * when the suite runs.
 */
const SWEEP_AT = new Date('2026-09-05T09:00:00Z');
const OVERDUE = new Date('2026-09-03T09:00:00Z');
const NOT_YET = new Date('2026-09-07T09:00:00Z');

describe('expiring unanswered requests (§8.6, slice 4.7a)', () => {
  it('moves an overdue request to EXPIRED and writes one event with no actor', async () => {
    const listingId = await newListing();
    const request = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: OVERDUE,
      }),
    );

    const { expired, reachedLimit } = await store.expireRequests(SWEEP_AT, 500);

    expect(expired.map((row) => row.id)).toEqual([request.id]);
    expect(reachedLimit).toBe(false);

    const after = await client.booking.findFirstOrThrow({ where: { id: request.id } });
    expect(after.state).toBe('EXPIRED');

    const events = await client.bookingEvent.findMany({
      where: { bookingId: request.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'state-changed',
      fromState: 'REQUESTED',
      toState: 'EXPIRED',
      // Null because the deadline decided this, not a person. The schema's own
      // words: recording one would be a lie about who decided.
      actorId: null,
    });
  });

  it('leaves a request whose deadline has not passed', async () => {
    const listingId = await newListing();
    const request = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: NOT_YET,
      }),
    );

    const { expired } = await store.expireRequests(SWEEP_AT, 500);

    expect(expired).toEqual([]);
    const after = await client.booking.findFirstOrThrow({ where: { id: request.id } });
    expect(after.state).toBe('REQUESTED');
  });

  it('leaves every state but REQUESTED, however overdue the column says it is', async () => {
    /*
     * **The predicate that matters, and the one a refactor would drop.**
     * `requestExpiresAt` stays on the row after the request is answered — nothing
     * clears it, deliberately (§7 reaches `EXPIRED` from three states and each gets
     * its own column). So a sweep filtering on the deadline *alone* would expire
     * confirmed bookings, which is the worst thing in this slice: it would release
     * a hire two people had agreed.
     */
    const listingId = await newListing();
    const accepted = await store.create(
      await booking(listingId, await newUser(), {
        state: 'ACCEPTED',
        requestExpiresAt: OVERDUE,
      }),
    );

    const { expired } = await store.expireRequests(SWEEP_AT, 500);

    expect(expired).toEqual([]);
    const after = await client.booking.findFirstOrThrow({ where: { id: accepted.id } });
    expect(after.state).toBe('ACCEPTED');
    expect(await client.bookingEvent.count({ where: { bookingId: accepted.id } })).toBe(
      0,
    );
  });

  it('expires the longest-overdue first, and reports a filled batch', async () => {
    const listingId = await newListing();
    const older = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: new Date('2026-09-01T09:00:00Z'),
      }),
    );
    await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: new Date('2026-09-02T09:00:00Z'),
      }),
    );

    const first = await store.expireRequests(SWEEP_AT, 1);

    expect(first.expired.map((row) => row.id)).toEqual([older.id]);
    // The bound was reached, so the caller is told to come back rather than
    // being left to assume the queue is empty.
    expect(first.reachedLimit).toBe(true);

    const second = await store.expireRequests(SWEEP_AT, 1);
    expect(second.expired).toHaveLength(1);
    expect(second.expired[0]?.id).not.toBe(older.id);
  });

  it('expires nothing on a second sweep', async () => {
    const listingId = await newListing();
    await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: OVERDUE,
      }),
    );

    await store.expireRequests(SWEEP_AT, 500);
    const again = await store.expireRequests(SWEEP_AT, 500);

    expect(again.expired).toEqual([]);
  });

  it('lets exactly one of two simultaneous sweeps expire each request', async () => {
    /*
     * Two sweeps launched together, and **what this proves is narrower than it
     * looks — it was written claiming more and a mutation test caught it.** With
     * the state predicate removed from the `UPDATE` this still passed all 66 tests,
     * because the two transactions serialise: by the time the second one *reads*
     * its candidates the first has committed, so the row is already `EXPIRED` and
     * never reaches the predicate at all.
     *
     * So this is a test that a sweep is safe to run twice at once — no double
     * claim, no double event, no deadlock — which is worth having on its own. The
     * predicate it does **not** isolate is the subject of the test below, which
     * interleaves the two halves deliberately.
     */
    const listingId = await newListing();
    const request = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: OVERDUE,
      }),
    );

    const second = createPrismaClient({ connectionString });
    try {
      const results = await Promise.all([
        store.expireRequests(SWEEP_AT, 500),
        new PrismaBookingStore(second).expireRequests(SWEEP_AT, 500),
      ]);

      const winners = results.flatMap((result) => result.expired.map((row) => row.id));
      expect(winners).toEqual([request.id]);

      // The assertion that actually matters: one state change, one event.
      expect(
        await client.bookingEvent.count({ where: { bookingId: request.id } }),
      ).toBe(1);
    } finally {
      await second.$disconnect();
    }
  });

  it('does not expire a request that was answered after the candidates were read', async () => {
    /*
     * **The predicate inside the `UPDATE`, isolated.** The test above cannot reach
     * it because two whole sweeps serialise; this one holds the first sweep open
     * *between* its read and its write, lets a complete second sweep commit in the
     * gap, and only then lets the first one write.
     *
     * That is the real production race, and it is not hypothetical: 4.6a's
     * acceptance runs exactly there. An owner pressing Accept while a sweep is
     * mid-flight must not have their confirmed booking expired out from under them.
     *
     * **What this pins is the mechanism, not the adapter, and the distinction is
     * not a quibble.** The two statements are restated here because
     * `expireRequests` correctly offers no way to pause halfway — so this test
     * drives its own SQL, and **removing the predicate from the adapter does not
     * make this test fail.** An earlier version of this comment claimed it did;
     * that was wrong, and the mutation run is what said so.
     *
     * So the honest position, also recorded in the adapter: the in-`UPDATE`
     * predicate is **defence in depth that no test can currently pin**, because the
     * candidates read filters the same rows a moment earlier and closes every window
     * a test can reach through the public method. It is kept because the window it
     * covers is real — 4.6a's acceptance runs in exactly that gap — and because this
     * test proves the mechanism it depends on: an `UPDATE` blocked on a row lock
     * re-evaluates its `WHERE` against the committed row and matches nothing.
     *
     * Do not delete the predicate on the grounds that nothing fails.
     */
    const listingId = await newListing();
    const request = await store.create(
      await booking(listingId, await newUser(), {
        state: 'REQUESTED',
        requestExpiresAt: OVERDUE,
      }),
    );

    let release = (): void => {};
    const gap = new Promise<void>((resolve) => {
      release = resolve;
    });

    const second = createPrismaClient({ connectionString });
    try {
      // The first sweep: read, wait, then write.
      const interrupted = client.$transaction(async (tx) => {
        const candidates = await tx.booking.findMany({
          where: { state: 'REQUESTED', requestExpiresAt: { lte: SWEEP_AT } },
          orderBy: [{ requestExpiresAt: 'asc' }, { id: 'asc' }],
          take: 500,
          select: { id: true },
        });

        // It saw the request while it was still REQUESTED.
        expect(candidates.map((row) => row.id)).toEqual([request.id]);

        await gap;

        return tx.booking.updateManyAndReturn({
          where: {
            id: { in: candidates.map((row) => row.id) },
            state: 'REQUESTED',
            requestExpiresAt: { lte: SWEEP_AT },
          },
          data: { state: 'EXPIRED' },
          select: { id: true },
        });
      });

      // In the gap, a complete second sweep expires it and commits.
      const winner = await new PrismaBookingStore(second).expireRequests(SWEEP_AT, 500);
      expect(winner.expired.map((row) => row.id)).toEqual([request.id]);

      release();
      const loser = await interrupted;

      // **The assertion.** The first sweep held a matching id and wrote nothing,
      // because the row is no longer an overdue REQUESTED.
      expect(loser).toEqual([]);

      // And therefore exactly one event exists, not two.
      expect(
        await client.bookingEvent.count({ where: { bookingId: request.id } }),
      ).toBe(1);
    } finally {
      await second.$disconnect();
    }
  });
});

describe('the dashboards, against the real query (slice 4.8a)', () => {
  /*
   * **What only this file can show.** The service tests run over an in-memory
   * array that knows who owns a listing because a test told it; here the owner is
   * a column on another table and the scope is a join. A scope that lives in the
   * query is the whole argument for these reads — a comparison afterwards is a
   * line somebody can delete — and this is the only place that argument is
   * actually tested.
   */

  it('gives a renter their own bookings and nobody else’s', async () => {
    const listingId = await newListing();
    const ada = await newUser();
    const bob = await newUser();
    const hers = await store.create(
      await booking(listingId, ada, { startAt: MONDAY, endAt: WEDNESDAY }),
    );
    await store.create(
      await booking(listingId, bob, { startAt: FRIDAY, endAt: SUNDAY }),
    );

    const listed = await store.findForRenter(ada, 10);

    expect(listed.map((row) => row.id)).toEqual([hers.id]);
  });

  it('gives an owner every booking on their listings, through the join', async () => {
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const ada = await newUser();
    const bob = await newUser();
    const first = await store.create(
      await booking(listingId, ada, { startAt: MONDAY, endAt: WEDNESDAY }),
    );
    const second = await store.create(
      await booking(listingId, bob, { startAt: FRIDAY, endAt: SUNDAY }),
    );

    const listed = await store.findForOwner(owner, 10);

    expect(listed.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('never gives an owner a booking on somebody else’s listing', async () => {
    // Two listings with different owners, one booking each. The owner of the
    // first must not see the second, and the scope that stops it is the join.
    const mine = await newListing();
    const theirs = await newListing();
    const owner = await ownerOf(mine);
    const ada = await newUser();
    const onMine = await store.create(await booking(mine, ada));
    await store.create(await booking(theirs, ada));

    const listed = await store.findForOwner(owner, 10);

    expect(listed.map((row) => row.id)).toEqual([onMine.id]);
  });

  it('reads empty for somebody with no bookings and no listings', async () => {
    const stranger = await newUser();

    expect(await store.findForRenter(stranger, 10)).toEqual([]);
    expect(await store.findForOwner(stranger, 10)).toEqual([]);
  });

  it('orders newest first', async () => {
    const listingId = await newListing();
    const ada = await newUser();
    const first = await store.create(
      await booking(listingId, ada, { startAt: MONDAY, endAt: WEDNESDAY }),
    );
    const second = await store.create(
      await booking(listingId, ada, { startAt: FRIDAY, endAt: SUNDAY }),
    );

    const listed = await store.findForRenter(ada, 10);

    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it('breaks a same-millisecond tie by id, so the order is total', async () => {
    /*
     * **Written because mutation showed nothing pinned it.** Removing the `id`
     * from the `ORDER BY` left all 75 tests in this file green: Postgres stamps
     * two inserts with different clock readings, so the tie the tiebreak exists
     * for never occurs by accident here.
     *
     * **It is not hypothetical, and it is not even rare.** `bookings.createdAt`
     * is `Timestamptz(3)` — milliseconds — and the local development fixture
     * already contains two pairs of bookings stamped to the same millisecond
     * (`09:15:45.172Z` and `09:43:40.375Z`), read back through this adapter on
     * 19 August 2026. §7.1's acceptance transaction is a structural source of
     * them: it writes the accepted booking and every auto-declined one together.
     * Without a total order those rows may come back in either order on either
     * read. `booking_events` already carries an `[bookingId, createdAt, id]`
     * index for exactly this reason.
     *
     * So the tie is forced rather than waited for.
     */
    const listingId = await newListing();
    const ada = await newUser();
    const first = await store.create(
      await booking(listingId, ada, { startAt: MONDAY, endAt: WEDNESDAY }),
    );
    const second = await store.create(
      await booking(listingId, ada, { startAt: FRIDAY, endAt: SUNDAY }),
    );

    const sameMoment = new Date('2026-09-01T12:00:00.000Z');
    await client.booking.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { createdAt: sameMoment },
    });

    const listed = await store.findForRenter(ada, 10);

    // Descending by id, deterministically, rather than by whatever order the
    // rows happen to arrive in.
    const expected = [first.id, second.id].sort().reverse();
    expect(listed.map((row) => row.id)).toEqual(expected);
  });

  it('returns no more rows than it was asked for', async () => {
    // The caller passes `Paging.probe(limit)` and trims. If `take` were ignored
    // the truncation flag would be decided by a number the database never
    // honoured, and the page would silently be complete.
    const listingId = await newListing();
    const ada = await newUser();
    await store.create(
      await booking(listingId, ada, { startAt: MONDAY, endAt: WEDNESDAY }),
    );
    await store.create(
      await booking(listingId, ada, { startAt: FRIDAY, endAt: SUNDAY }),
    );

    expect(await store.findForRenter(ada, 1)).toHaveLength(1);
  });

  it('reads back the terms the booking was made under', async () => {
    // §8.2's copy, proved through the real columns rather than a fake's echo.
    const listingId = await newListing();
    const ada = await newUser();
    const created = await store.create(await booking(listingId, ada));

    const [row] = await store.findForRenter(ada, 10);

    expect(row?.itemTitle).toBe(created.itemTitle);
    expect(row?.total).toEqual(created.total);
    expect(row?.itemCharge).toEqual(created.itemCharge);
  });

  it('carries every state, including the ones the requests panel excludes', async () => {
    // `findPendingRequests` answers what an owner must decide and drops anything
    // answered or past its deadline. A dashboard that inherited those filters
    // would hide exactly the bookings this slice exists to show.
    const listingId = await newListing();
    const owner = await ownerOf(listingId);
    const ada = await newUser();
    await store.create(
      await booking(listingId, ada, {
        state: 'ACCEPTED',
        startAt: MONDAY,
        endAt: WEDNESDAY,
      }),
    );
    await store.create(
      await booking(listingId, ada, {
        state: 'EXPIRED',
        startAt: FRIDAY,
        endAt: SUNDAY,
      }),
    );

    const listed = await store.findForOwner(owner, 10);

    expect(listed.map((row) => row.state).sort()).toEqual(['ACCEPTED', 'EXPIRED']);
  });
});

describe('one quote, one booking (slice 4.7a)', () => {
  it('refuses a second booking made from the same quote', async () => {
    /*
     * The migration's whole subject. §7.1 leaves `REQUESTED` out of §8.5.1's nine
     * occupying states so several renters can ask for the same dates — which means
     * the `EXCLUDE` constraint cannot see this, and a double-press produced two
     * identical rows until the unique index existed.
     */
    const listingId = await newListing();
    const renterId = await newUser();
    const first = await booking(listingId, renterId, { state: 'REQUESTED' });
    await store.create(first);

    await expect(
      store.create(
        await booking(listingId, renterId, {
          state: 'REQUESTED',
          quoteId: first.quoteId,
          // Different dates, so the refusal cannot be the overlap constraint.
          startAt: FRIDAY,
          endAt: SUNDAY,
        }),
      ),
    ).rejects.toThrow(DuplicateQuoteBookingError);
  });

  it('still lets two different quotes become two bookings', async () => {
    // The constraint must bind the quote and nothing else — §7.1 requires several
    // renters to be able to request the same dates.
    const listingId = await newListing();
    await store.create(
      await booking(listingId, await newUser(), { state: 'REQUESTED' }),
    );

    await expect(
      store.create(await booking(listingId, await newUser(), { state: 'REQUESTED' })),
    ).resolves.toMatchObject({ state: 'REQUESTED' });
  });
});
