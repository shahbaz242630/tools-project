/**
 * Payment attempts against a real PostgreSQL (slice 5.2b).
 *
 * Needs `pnpm db:up` and migrations applied to the test database.
 *
 * **What only this file can prove**, every item being a rule the in-memory fake
 * is structurally unable to be evidence for:
 *
 * - **at most one succeeded attempt per booking and purpose**, as a partial
 *   unique index. §8.7.1: *"only one capture is possible per authorisation"*, so
 *   a second capture against one booking is a double charge and this is where it
 *   becomes unrepresentable;
 * - the index is **partial**, so failed attempts accumulate — which is what a
 *   retry after a decline is;
 * - `attemptKey` is **unique**, which is the double-press guard, and the loser of
 *   a race **succeeds** rather than raising;
 * - the four **CHECKs** hold: a blank attempt key, a non-positive amount, a
 *   total that is not its parts, and a succeeded row with no provider reference;
 * - `ON DELETE RESTRICT` on all three foreign keys, so an attempt **holds its
 *   booking, its payee and the version that priced it** — the reference ADR
 *   0015's soft delete was anticipating, one table further on.
 *
 * **Ordinary `deleteMany` cleanup, unlike the ledger beside it.** `payment_intents`
 * is mutable by design and carries no immutability trigger, so it needs none of
 * `prisma-ledger-store.db.test.ts`'s TRUNCATE workaround.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { Money, Time } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  DEFAULT_REQUEST_EXPIRY_HOURS,
} from '@platform/contracts';
import { PrismaCategoryStore } from '../catalogue/prisma-category-store.js';
import { PrismaListingStore } from '../catalogue/prisma-listing-store.js';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { PaymentIntentError } from './payment-intent.js';
import type { NewPaymentIntent } from './payment-intent.js';
import { PrismaPaymentIntentStore } from './prisma-payment-intent-store.js';

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
  // A throwaway key: this file writes a listing only so a booking has something
  // to point at, and never reads an address back.
  createFieldEncryptor(Buffer.alloc(32, 7).toString('base64')),
);
const store = new PrismaPaymentIntentStore(client);

const GBP = 'GBP' as const;
const pence = (n: number): MoneyValue => Money.money(n, GBP);

const MONDAY = new Date('2026-09-14T09:00:00.000Z');
const FRIDAY = new Date('2026-09-18T09:00:00.000Z');

let bookingId: string;
let ownerId: string;
let categoryVersionId: string;

/** Children before parents, the order every integration file here uses. */
async function clearEverything(): Promise<void> {
  await client.paymentIntent.deleteMany();
  await client.$executeRawUnsafe(
    'TRUNCATE "ledger_entries", "ledger_transactions", "ledger_accounts" CASCADE',
  );
  await client.bookingEvent.deleteMany();
  await client.booking.deleteMany();
  await client.availabilityBlock.deleteMany();
  await client.quote.deleteMany();
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
}

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
  await clearEverything();

  ownerId = await newUser();
  const renterId = await newUser();

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
        minimumBookingTotal: { amount: 1_000, currency: GBP },
        minimumPlatformFee: { amount: 100, currency: GBP },
      },
      // No damage-security band, which is §8.7.2's "requires no security" and
      // is honest here: nothing in this file is about a hold. It also puts the
      // null case through the real store, where the `damage_security_is_complete`
      // CHECK is what would refuse a half-written one.
      damageSecurity: null,
      transportOptions: [],
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
    },
    ownerId,
  );

  const listing = await listings.createDraft({
    ownerId,
    categorySlug: category.slug,
    title: 'Petrol hedge trimmer',
    description: 'Serviced last spring.',
    replacementValue: { amount: 24_999, currency: GBP },
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
    rates: { daily: { amount: 1_800, currency: GBP }, weekend: null, weekly: null },
    categoryVersionNumber: 1,
  });

  const version = await client.categoryVersion.findFirstOrThrow({
    where: { listings: { some: { id: listing.id } } },
  });
  categoryVersionId = version.id;

  const quote = await client.quote.create({
    data: {
      listingId: listing.id,
      renterId,
      startAt: MONDAY,
      endAt: FRIDAY,
      timeZone: 'Europe/London',
      renterPostcode: 'BS7 8AA',
      itemChargeAmount: 5_400,
      renterFeeAmount: 432,
      totalAmount: 5_832,
      currency: GBP,
      minimumFeeApplied: false,
      lineItems: [
        {
          unit: 'day',
          count: 3,
          unitPrice: { amount: 1_800, currency: GBP },
          subtotal: { amount: 5_400, currency: GBP },
        },
      ],
      categoryVersionId,
      expiresAt: new Date(MONDAY.getTime() + 30 * 60_000),
    },
  });

  const booking = await client.booking.create({
    data: {
      listingId: listing.id,
      renterId,
      state: 'ACCEPTED',
      startAt: MONDAY,
      endAt: FRIDAY,
      timeZone: 'Europe/London',
      quoteId: quote.id,
      categoryVersionId,
      itemChargeAmount: 5_400,
      renterFeeAmount: 432,
      totalAmount: 5_832,
      currency: GBP,
      itemTitle: 'Petrol hedge trimmer',
      categoryName: 'Outdoor and gardening',
      requestExpiresAt: new Date(MONDAY.getTime() + 48 * 3_600_000),
    },
  });
  bookingId = booking.id;
});

afterAll(async () => {
  // Unconditionally, even after a failure: these rows hold `users`, `bookings`
  // and `category_versions` through RESTRICT foreign keys, and every other
  // integration file deletes users in its own setup.
  await clearEverything();
  await client.$disconnect();
});

function attempt(over: Partial<NewPaymentIntent> = {}): NewPaymentIntent {
  return {
    bookingId,
    ownerId,
    categoryVersionId,
    purpose: 'hire_charge',
    attemptKey: `attempt-${randomUUID()}`,
    itemCharge: pence(5_400),
    renterFee: pence(432),
    amount: pence(5_832),
    provider: 'fake',
    ...over,
  };
}

/** Write a row directly, so a CHECK can be fired without the adapter's help. */
async function insertRaw(over: Record<string, unknown> = {}): Promise<void> {
  await client.paymentIntent.create({
    data: {
      bookingId,
      ownerId,
      categoryVersionId,
      purpose: 'hire_charge',
      attemptKey: `raw-${randomUUID()}`,
      status: 'initiated',
      provider: 'fake',
      itemChargeMinor: 5_400,
      renterFeeMinor: 432,
      amountMinor: 5_832,
      currency: GBP,
      ...over,
    },
  });
}

describe('opening an attempt', () => {
  it('writes it as initiated, with no provider reference yet', async () => {
    const intent = await store.begin(attempt());

    // The row exists *before* the provider is called, so a crash between the
    // two leaves a record rather than an untraceable charge.
    expect(intent.status).toBe('initiated');
    expect(intent.providerReference).toBeUndefined();
    expect(intent.amount).toEqual(pence(5_832));
    expect(intent.itemCharge).toEqual(pence(5_400));
    expect(intent.renterFee).toEqual(pence(432));
  });

  it('returns the same row for the same attempt key', async () => {
    const proposed = attempt();

    const first = await store.begin(proposed);
    const second = await store.begin(proposed);

    // The double press. One row, and the caller can tell it is the same one.
    expect(second.id).toBe(first.id);
    expect(await client.paymentIntent.count()).toBe(1);
  });

  it('lets the loser of a race succeed rather than raise', async () => {
    /*
     * Two presses milliseconds apart. Prisma has no atomic `ON CONFLICT`, so one
     * of these can lose on the unique index — and losing must mean *reading the
     * winner's row*, not failing. `PrismaLedgerStore.accountFor` learned that a
     * green local run proves little here: thirty concurrent callers produce no
     * rejection on a development machine and four did on CI.
     */
    const proposed = attempt();

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => store.begin(proposed)),
    );

    const ids = new Set(results.map((intent) => intent.id));
    expect(ids.size).toBe(1);
    expect(await client.paymentIntent.count()).toBe(1);
  });

  it('returns the row it found, whatever the caller proposed', async () => {
    /*
     * **The adapter does not judge, deliberately.** Refusing a key reused for
     * different money is `assertSameAttempt`'s job, in the pure layer, so there
     * is one copy of the rule rather than one per store — `LedgerService.post`
     * makes the same call. What this proves is the half only Postgres can: the
     * unique index means the second caller reads the first row rather than
     * writing a second.
     */
    const proposed = attempt();
    const first = await store.begin(proposed);

    const second = await store.begin({
      ...proposed,
      itemCharge: pence(9_000),
      renterFee: pence(0),
      amount: pence(9_000),
    });

    expect(second.id).toBe(first.id);
    expect(second.amount).toEqual(pence(5_832));
    expect(await client.paymentIntent.count()).toBe(1);
  });
});

describe('the rules the database keeps', () => {
  it('refuses a blank attempt key', async () => {
    await expect(insertRaw({ attemptKey: '   ' })).rejects.toThrow();
  });

  it('refuses a charge of nothing', async () => {
    await expect(
      insertRaw({ itemChargeMinor: 0, renterFeeMinor: 0, amountMinor: 0 }),
    ).rejects.toThrow();
  });

  it('refuses a total that is not its parts', async () => {
    // The same rule `settleHire` applies in code, one layer down — so a row
    // that disagrees with itself cannot exist to be settled from.
    await expect(insertRaw({ amountMinor: 9_999 })).rejects.toThrow();
  });

  it('refuses a succeeded attempt with no provider reference', async () => {
    // Daily reconciliation (§8.7) has nothing to match against without one.
    await expect(insertRaw({ status: 'succeeded' })).rejects.toThrow();
  });

  it('refuses a failed attempt with no reason', async () => {
    await expect(insertRaw({ status: 'failed' })).rejects.toThrow();
  });

  it('permits a renter fee of zero, because a category may run at cost', async () => {
    await insertRaw({ renterFeeMinor: 0, amountMinor: 5_400 });
    expect(await client.paymentIntent.count()).toBe(1);
  });
});

describe('§8.7.1: one capture per booking', () => {
  it('refuses a second succeeded attempt against the same booking', async () => {
    const first = await store.begin(attempt());
    await store.recordOutcome(first.id, {
      status: 'succeeded',
      providerReference: 'ref-1',
    });

    const second = await store.begin(attempt());

    // A double charge at the provider, made unrepresentable here rather than
    // merely refused by whichever code path happened to check.
    await expect(
      store.recordOutcome(second.id, {
        status: 'succeeded',
        providerReference: 'ref-2',
      }),
    ).rejects.toBeInstanceOf(PaymentIntentError);
  });

  it('lets failed attempts accumulate, because the index is partial', async () => {
    for (let i = 0; i < 3; i += 1) {
      const intent = await store.begin(attempt());
      await store.recordOutcome(intent.id, {
        status: 'failed',
        providerReference: `ref-${String(i)}`,
        failure: { reason: 'declined', message: 'Your card was declined.' },
      });
    }

    const succeeded = await store.begin(attempt());
    await store.recordOutcome(succeeded.id, {
      status: 'succeeded',
      providerReference: 'ref-final',
    });

    // Three declines then a success is an ordinary evening, not a defect.
    expect(await store.findForBooking(bookingId)).toHaveLength(4);
  });
});

describe('recording an outcome', () => {
  it('keeps the failure reason and the sentence a payer is shown', async () => {
    const intent = await store.begin(attempt());

    const failed = await store.recordOutcome(intent.id, {
      status: 'failed',
      providerReference: 'ref-1',
      failure: { reason: 'authentication_failed', message: 'That check failed.' },
    });

    expect(failed.failure).toEqual({
      reason: 'authentication_failed',
      message: 'That check failed.',
    });
  });

  it('keeps the provider’s own expiry timestamp, never a duration', async () => {
    // §8.7.2 is normative about this: read `capture_before` rather than assuming
    // seven days, because a merchant-initiated Visa re-auth holds five.
    const capturesBefore = new Date('2026-09-19T09:00:00.000Z');
    const intent = await store.begin(attempt());

    const held = await store.recordOutcome(intent.id, {
      status: 'processing',
      providerReference: 'ref-1',
      authorisationExpiresAt: capturesBefore,
    });

    expect(held.authorisationExpiresAt).toEqual(capturesBefore);
  });
});

describe('reading attempts', () => {
  it('returns a booking’s attempts newest first', async () => {
    const first = await store.begin(attempt({ attemptKey: 'a' }));
    const second = await store.begin(attempt({ attemptKey: 'b' }));

    const found = await store.findForBooking(bookingId);
    expect(found.map((intent) => intent.id)).toEqual([second.id, first.id]);
  });

  it('resolves to null for an id that does not exist', async () => {
    expect(await store.findById(randomUUID())).toBeNull();
  });
});

describe('what an attempt holds hostage', () => {
  it('refuses to delete the payee', async () => {
    // ADR 0015 soft-deletes accounts precisely so a financial record can never
    // lose its counterparty. This is that reference, one table on from the
    // ledger.
    await store.begin(attempt());

    await expect(client.user.delete({ where: { id: ownerId } })).rejects.toThrow();
  });

  it('refuses to delete the version that priced it', async () => {
    // §8.2: the rate must stay provable. A payment whose commission cannot be
    // looked up is a payout nobody can explain.
    await store.begin(attempt());

    await expect(
      client.categoryVersion.delete({ where: { id: categoryVersionId } }),
    ).rejects.toThrow();
  });

  it('refuses to delete the booking it paid for', async () => {
    await store.begin(attempt());

    await expect(client.booking.delete({ where: { id: bookingId } })).rejects.toThrow();
  });
});

/**
 * The reconciliation query (slice 5.4a).
 *
 * **What only a real database can show here is the predicate itself** — that
 * `notIn` the terminal statuses does what listing the live ones would appear to,
 * that the `updatedAt` comparison is applied by Postgres rather than by a filter
 * the fake happens to share, and that ordering and the batch bound survive the
 * round trip.
 */
describe('finding attempts to reconcile', () => {
  /** Move a row's `updatedAt` back, which is the one thing `begin` cannot do. */
  const age = async (id: string, minutes: number): Promise<void> => {
    await client.paymentIntent.update({
      where: { id },
      data: { updatedAt: Time.addMinutes(Time.nowUtc(), -minutes) },
    });
  };

  const staleBefore = () => Time.addMinutes(Time.nowUtc(), -15);

  it('finds an unsettled attempt that has not changed for a while', async () => {
    const intent = await store.begin(attempt({ attemptKey: 'stale' }));
    await age(intent.id, 60);

    const found = await store.findUnsettled(staleBefore(), 10);

    expect(found.map((row) => row.id)).toEqual([intent.id]);
  });

  it('ignores one that changed recently', async () => {
    // Written seconds ago by `begin`, so it is not stale by construction.
    await store.begin(attempt({ attemptKey: 'fresh' }));

    expect(await store.findUnsettled(staleBefore(), 10)).toHaveLength(0);
  });

  /**
   * **The reason the query says `notIn` the terminal statuses rather than `in` the
   * live ones.** Every payment ever taken is `succeeded`; a query that pulled them
   * back to discard them would get more expensive with every booking completed.
   */
  it('ignores an attempt that has already settled, however old', async () => {
    const succeeded = await store.begin(attempt({ attemptKey: 'done' }));
    await store.recordOutcome(succeeded.id, {
      status: 'succeeded',
      providerReference: 'pi_done',
    });
    await age(succeeded.id, 600);

    expect(await store.findUnsettled(staleBefore(), 10)).toHaveLength(0);
  });

  it('returns one with no provider reference, because that is the alarming case', async () => {
    // It cannot be reconciled — there is nothing to read — and hiding it in the
    // query would make the one case worth alerting on the one nobody ever sees.
    const orphan = await store.begin(attempt({ attemptKey: 'orphan' }));
    await age(orphan.id, 120);

    const found = await store.findUnsettled(staleBefore(), 10);

    expect(found).toHaveLength(1);
    expect(found[0]?.providerReference).toBeUndefined();
  });

  it('returns the longest-stuck first, so a bounded batch is deterministic', async () => {
    const older = await store.begin(attempt({ attemptKey: 'older' }));
    const newer = await store.begin(attempt({ attemptKey: 'newer' }));
    await age(older.id, 300);
    await age(newer.id, 60);

    const found = await store.findUnsettled(staleBefore(), 10);

    expect(found.map((row) => row.id)).toEqual([older.id, newer.id]);
  });

  it('honours the batch bound', async () => {
    for (const key of ['one', 'two', 'three']) {
      const intent = await store.begin(attempt({ attemptKey: key }));
      await age(intent.id, 60);
    }

    expect(await store.findUnsettled(staleBefore(), 2)).toHaveLength(2);
  });
});
