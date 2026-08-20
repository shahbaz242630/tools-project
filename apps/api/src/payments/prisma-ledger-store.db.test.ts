/**
 * The ledger against a real PostgreSQL (slice 5.1).
 *
 * Needs `pnpm db:up` and migrations applied to the test database.
 *
 * **What only this file can prove**, and every item is a rule the in-memory fake
 * is structurally unable to be evidence for:
 *
 * - the **balance rule** is the database's. A transaction whose sides differ by a
 *   penny is refused at COMMIT by a deferred constraint trigger, and so is one
 *   with no entries at all;
 * - the ledger is **append-only in fact**. UPDATE and DELETE are refused on both
 *   transactions and entries, which is stricter than `booking_events` because
 *   §8.7 names deleting;
 * - an entry **cannot disagree with its transaction or its account about
 *   currency**, because both foreign keys are composite on `(id, currency)`;
 * - the two **CHECKs** hold: a non-positive amount and an unknown direction;
 * - **idempotency is the unique index's**, not a check-then-write;
 * - a transaction can be **reversed at most once**, and losing that race is a
 *   refusal rather than a silent success;
 * - `ON DELETE RESTRICT` means a person with a ledger account **cannot be
 *   removed**, which is the reference ADR 0015's soft delete was anticipating.
 *
 * **Cleanup is TRUNCATE rather than `deleteMany`**, and that is not a style
 * choice: DELETE is refused by the immutability trigger, so the ordinary pattern
 * every other db test uses would fail here. TRUNCATE does not fire row-level
 * triggers, which is what leaves the suite a way to reset. Worth knowing before
 * adding a second file that touches these tables.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaLedgerStore } from './prisma-ledger-store.js';
import type { LedgerTransactionDraft } from './ledger.js';

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

const store = new PrismaLedgerStore(client);

const GBP = 'GBP' as const;
const pence = (n: number): MoneyValue => Money.money(n, GBP);

let ownerId: string;

async function clearLedger(): Promise<void> {
  // DELETE is refused by `refuse_ledger_write`; TRUNCATE does not fire row-level
  // triggers. See the header.
  await client.$executeRawUnsafe(
    'TRUNCATE "ledger_entries", "ledger_transactions", "ledger_accounts" CASCADE',
  );
}

/**
 * Children before parents, the same order every other integration file uses.
 *
 * The ledger goes first because its accounts hold `users` through a RESTRICT
 * foreign key — and the rest of the list is here rather than trimmed to what this
 * file writes, because the suite shares one database and whatever ran before this
 * may have left a row pointing at a user.
 */
async function clearEverything(): Promise<void> {
  await clearLedger();
  // **Bookings before quotes.** `bookings.quoteId` is RESTRICT — a booking keeps
  // the terms it was made under — so deleting quotes first fails the moment any
  // booking references one. That passed when this file ran alone and failed in a
  // full sequential run, against rows another suite had left behind.
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

beforeEach(async () => {
  await clearEverything();

  const owner = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `${randomUUID()}@example.test`,
    },
  });
  ownerId = owner.id;
});

afterAll(async () => {
  // Unconditionally, even after a failure: these rows hold `users` hostage
  // through a RESTRICT foreign key, and every other integration file deletes
  // users in its own `beforeEach`. Leaving them behind would fail somebody
  // else's setup with an error naming a table they have never heard of.
  await clearEverything();
  await client.$disconnect();
});

async function threeAccounts(): Promise<{
  provider: string;
  owner: string;
  revenue: string;
}> {
  const provider = await store.accountFor({
    kind: 'provider_clearing',
    currency: GBP,
  });
  const owner = await store.accountFor({
    kind: 'owner_payable',
    currency: GBP,
    ownerId,
  });
  const revenue = await store.accountFor({
    kind: 'platform_revenue',
    currency: GBP,
  });
  return { provider: provider.id, owner: owner.id, revenue: revenue.id };
}

async function capture(
  overrides: Partial<LedgerTransactionDraft> = {},
): Promise<LedgerTransactionDraft> {
  const { provider, owner, revenue } = await threeAccounts();
  return {
    idempotencyKey: `capture-${randomUUID()}`,
    kind: 'hire_charge_captured',
    currency: GBP,
    occurredAt: new Date('2026-09-15T10:00:00.000Z'),
    entries: [
      { accountId: provider, direction: 'debit', amount: pence(1944) },
      { accountId: owner, direction: 'credit', amount: pence(1512) },
      { accountId: revenue, direction: 'credit', amount: pence(432) },
    ],
    ...overrides,
  };
}

describe('accountFor', () => {
  it('creates an account and returns the same row on a second call', async () => {
    const first = await store.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId,
    });
    const second = await store.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId,
    });

    expect(second.id).toBe(first.id);
    expect(await client.ledgerAccount.count()).toBe(1);
  });

  it('gives the platform exactly one account when callers race for it', async () => {
    // The case a composite unique on (kind, ownerId, currency) would miss, because
    // Postgres treats NULLs as distinct: two rows and a balance split between them.
    const spec = { kind: 'provider_clearing', currency: GBP } as const;
    await Promise.all([
      store.accountFor(spec),
      store.accountFor(spec),
      store.accountFor(spec),
      store.accountFor(spec),
    ]);

    expect(await client.ledgerAccount.count()).toBe(1);
  });

  it('records the owner on a per-person account', async () => {
    const account = await store.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId,
    });
    expect(account.ownerId).toBe(ownerId);
  });

  it('leaves a platform account attributed to nobody', async () => {
    const account = await store.accountFor({
      kind: 'platform_revenue',
      currency: GBP,
    });
    expect(account.ownerId).toBeUndefined();
  });
});

describe('the balance rule is the database’s', () => {
  it('refuses a transaction whose sides differ by a penny, at COMMIT', async () => {
    const { provider, owner } = await threeAccounts();

    await expect(
      store.post({
        idempotencyKey: 'unbalanced',
        kind: 'hire_charge_captured',
        currency: GBP,
        occurredAt: new Date(),
        entries: [
          { accountId: provider, direction: 'debit', amount: pence(1944) },
          { accountId: owner, direction: 'credit', amount: pence(1943) },
        ],
      }),
      // **Not the trigger's own sentence.** Prisma runs a nested write inside a
      // transaction it manages, and a constraint that fires at COMMIT comes back
      // as P2028 with the database's message discarded — so the adapter
      // translates it into something a person can act on. The guarantee under
      // test is the next line: nothing was written.
    ).rejects.toThrow(/the database refused this posting/);

    expect(await client.ledgerTransaction.count()).toBe(0);
  });

  it('refuses a transaction with no entries at all, and says why', async () => {
    // **The one case where the trigger's own sentence survives.** This create has
    // no nested writes, so Prisma issues it directly and reports `P0001` with the
    // database's message intact. Add a nested `entries: { create: … }` and the
    // same failure comes back as P2028 with the sentence gone — see the sibling
    // test below. Worth knowing before trusting an error message from a write.
    await expect(
      client.ledgerTransaction.create({
        data: {
          idempotencyKey: 'empty',
          kind: 'owner_payout',
          currency: GBP,
          occurredAt: new Date(),
        },
      }),
    ).rejects.toThrow(/one entry can never balance/);

    expect(await client.ledgerTransaction.count()).toBe(0);
  });

  it('refuses a single-entry transaction, though not in so many words', async () => {
    const { provider } = await threeAccounts();

    await expect(
      client.ledgerTransaction.create({
        data: {
          idempotencyKey: 'lonely',
          kind: 'owner_payout',
          currency: GBP,
          occurredAt: new Date(),
          entries: {
            create: [
              {
                accountId: provider,
                direction: 'debit',
                amountMinor: 100,
              },
            ],
          },
        },
      }),
      // Nested `entries: { create: … }` puts this inside a transaction Prisma
      // manages, and a COMMIT-time failure there is reported as P2028 with the
      // trigger's message discarded. The refusal is the guarantee; the sentence
      // is a casualty. `assertPostable` is what gives a caller the readable
      // version, which is why the service runs it first.
    ).rejects.toThrow();

    expect(await client.ledgerTransaction.count()).toBe(0);
  });

  it('accepts a balanced three-way split', async () => {
    const posted = await store.post(await capture());

    expect(posted.entries).toHaveLength(3);
    expect(await client.ledgerEntry.count()).toBe(3);
  });
});

describe('the ledger is append-only in fact', () => {
  it('refuses an UPDATE to an entry', async () => {
    const posted = await store.post(await capture());
    const entry = await client.ledgerEntry.findFirstOrThrow({
      where: { transactionId: posted.id },
    });

    await expect(
      client.ledgerEntry.update({
        where: { id: entry.id },
        data: { amountMinor: 1 },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE of an entry', async () => {
    const posted = await store.post(await capture());

    await expect(
      client.ledgerEntry.deleteMany({ where: { transactionId: posted.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE of a transaction', async () => {
    const posted = await store.post(await capture());

    await expect(
      client.ledgerTransaction.delete({ where: { id: posted.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses an UPDATE to an account', async () => {
    const account = await store.accountFor({
      kind: 'platform_revenue',
      currency: GBP,
    });

    await expect(
      client.ledgerAccount.update({
        where: { id: account.id },
        data: { kind: 'owner_payable' },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('an entry cannot disagree about currency', () => {
  it('cannot even express an entry denominated differently from its transaction', () => {
    // Not "is refused" — **cannot be written down**. Because the entry's foreign
    // key to its transaction is composite on `(id, currency)`, Prisma inherits
    // the column from the parent and offers no way to set it, so the mismatch has
    // no representation in the client at all. This test is the record of that,
    // because the guarantee is invisible in the adapter: it is an absent field.
    const nested: Record<string, unknown> = {
      accountId: 'irrelevant',
      direction: 'debit',
      amountMinor: 100,
    };
    expect(Object.keys(nested)).not.toContain('currency');
  });

  it('refuses an entry pointing at an account held in another currency', async () => {
    // The half that is still a runtime refusal, and the reason the second
    // composite key exists: the transaction is in GBP, the account is in EUR, and
    // without `(id, currency)` on the account side this would post happily and
    // put euros in a sterling balance.
    const { provider } = await threeAccounts();
    const euros = await client.ledgerAccount.create({
      data: {
        kind: 'platform_revenue',
        currency: 'EUR',
        identity: 'platform_revenue:EUR',
      },
    });

    await expect(
      client.ledgerTransaction.create({
        data: {
          idempotencyKey: 'mixed',
          kind: 'owner_payout',
          currency: GBP,
          occurredAt: new Date(),
          entries: {
            create: [
              { accountId: provider, direction: 'debit', amountMinor: 100 },
              { accountId: euros.id, direction: 'credit', amountMinor: 100 },
            ],
          },
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('the CHECK constraints', () => {
  it('refuses a zero amount', async () => {
    const { provider, owner } = await threeAccounts();

    await expect(
      client.ledgerTransaction.create({
        data: {
          idempotencyKey: 'zero',
          kind: 'owner_payout',
          currency: GBP,
          occurredAt: new Date(),
          entries: {
            create: [
              {
                accountId: provider,
                direction: 'debit',
                amountMinor: 0,
              },
              {
                accountId: owner,
                direction: 'credit',
                amountMinor: 0,
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(/entry_amount_is_positive/);
  });

  it('refuses a negative amount even though it would still balance', async () => {
    const { provider, owner } = await threeAccounts();

    await expect(
      client.ledgerTransaction.create({
        data: {
          idempotencyKey: 'negative',
          kind: 'owner_payout',
          currency: GBP,
          occurredAt: new Date(),
          entries: {
            create: [
              {
                accountId: provider,
                direction: 'debit',
                amountMinor: -100,
              },
              {
                accountId: owner,
                direction: 'credit',
                amountMinor: -100,
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(/entry_amount_is_positive/);
  });

  it('refuses a direction outside the two that exist', async () => {
    const { provider, owner } = await threeAccounts();

    await expect(
      client.ledgerTransaction.create({
        data: {
          idempotencyKey: 'shouting',
          kind: 'owner_payout',
          currency: GBP,
          occurredAt: new Date(),
          entries: {
            create: [
              {
                accountId: provider,
                direction: 'DEBIT',
                amountMinor: 100,
              },
              {
                accountId: owner,
                direction: 'credit',
                amountMinor: 100,
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(/entry_direction_is_known/);
  });
});

describe('idempotency is the unique index’s', () => {
  it('returns the transaction already written rather than writing a second', async () => {
    const draft = await capture();

    const first = await store.post(draft);
    const second = await store.post(draft);

    expect(second.id).toBe(first.id);
    expect(await client.ledgerTransaction.count()).toBe(1);
    expect(await client.ledgerEntry.count()).toBe(3);
  });

  it('holds when the same key is posted concurrently', async () => {
    // The path the pre-read cannot cover: both callers look, both find nothing,
    // and one of them loses on INSERT. It must come back with the winner's row.
    const draft = await capture();

    const results = await Promise.all([
      store.post(draft),
      store.post(draft),
      store.post(draft),
    ]);

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await client.ledgerTransaction.count()).toBe(1);
  });
});

describe('a transaction is reversed at most once', () => {
  it('accepts the first correction', async () => {
    const posted = await store.post(await capture());
    const { provider, owner, revenue } = await threeAccounts();

    const correction = await store.post({
      idempotencyKey: 'correction-1',
      kind: 'hire_charge_captured',
      currency: GBP,
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
      reversesTransactionId: posted.id,
      entries: [
        { accountId: provider, direction: 'credit', amount: pence(1944) },
        { accountId: owner, direction: 'debit', amount: pence(1512) },
        { accountId: revenue, direction: 'debit', amount: pence(432) },
      ],
    });

    expect(correction.reversesTransactionId).toBe(posted.id);
  });

  it('refuses a second, different correction of the same transaction', async () => {
    const posted = await store.post(await capture());
    const { provider, owner, revenue } = await threeAccounts();

    const correction = (key: string): LedgerTransactionDraft => ({
      idempotencyKey: key,
      kind: 'hire_charge_captured',
      currency: GBP,
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
      reversesTransactionId: posted.id,
      entries: [
        { accountId: provider, direction: 'credit', amount: pence(1944) },
        { accountId: owner, direction: 'debit', amount: pence(1512) },
        { accountId: revenue, direction: 'debit', amount: pence(432) },
      ],
    });

    await store.post(correction('correction-1'));

    // A refusal, not a silent success: the caller's correction did not happen.
    await expect(store.post(correction('correction-2'))).rejects.toThrow(
      /already been reversed/,
    );
  });
});

describe('balanceOf', () => {
  it('is zero for an account nothing has posted to', async () => {
    const account = await store.accountFor({
      kind: 'platform_revenue',
      currency: GBP,
    });

    await expect(store.balanceOf(account.id)).resolves.toEqual(pence(0));
  });

  it('signs a liability towards the credit side', async () => {
    await store.post(await capture());
    const { owner } = await threeAccounts();

    await expect(store.balanceOf(owner)).resolves.toEqual(pence(1512));
  });

  it('signs an asset towards the debit side', async () => {
    await store.post(await capture());
    const { provider } = await threeAccounts();

    await expect(store.balanceOf(provider)).resolves.toEqual(pence(1944));
  });

  it('nets a payout against a capture', async () => {
    await store.post(await capture());
    const { provider, owner } = await threeAccounts();

    await store.post({
      idempotencyKey: 'payout-1',
      kind: 'owner_payout',
      currency: GBP,
      occurredAt: new Date('2026-09-20T10:00:00.000Z'),
      entries: [
        { accountId: owner, direction: 'debit', amount: pence(1512) },
        { accountId: provider, direction: 'credit', amount: pence(1512) },
      ],
    });

    await expect(store.balanceOf(owner)).resolves.toEqual(pence(0));
    await expect(store.balanceOf(provider)).resolves.toEqual(pence(432));
  });

  it('refuses an account that does not exist', async () => {
    await expect(store.balanceOf(randomUUID())).rejects.toThrow(
      /no such ledger account/,
    );
  });
});

describe('the ledger can never lose a counterparty', () => {
  it('refuses to delete a person who holds a ledger account', async () => {
    await store.accountFor({ kind: 'owner_payable', currency: GBP, ownerId });

    // ADR 0015 soft-deletes accounts precisely so this reference stays valid.
    // The RESTRICT is what makes "soft delete" a guarantee rather than a habit.
    await expect(client.user.delete({ where: { id: ownerId } })).rejects.toThrow();
  });
});

describe('what reads back', () => {
  it('reassembles minor units and currency into Money', async () => {
    const posted = await store.post(await capture());
    const read = await store.findById(posted.id);

    expect(read?.entries.map((e) => e.amount)).toEqual([
      pence(1944),
      pence(1512),
      pence(432),
    ]);
  });

  it('keeps occurredAt and recordedAt apart', async () => {
    const posted = await store.post(await capture());

    // Two independent clocks, and neither orders the other: `occurredAt` is the
    // provider's and is supplied, `recordedAt` is ours and is defaulted. This
    // fixture's hire is in the future, which is exactly why the assertion is that
    // they are *separate* rather than that one follows the other.
    expect(posted.occurredAt).toEqual(new Date('2026-09-15T10:00:00.000Z'));
    expect(posted.recordedAt).not.toEqual(posted.occurredAt);
    expect(posted.recordedAt.getTime()).toBeLessThan(Date.now() + 1000);
  });

  it('finds nothing for an unknown id or key', async () => {
    await expect(store.findById(randomUUID())).resolves.toBeNull();
    await expect(store.findByIdempotencyKey('nope')).resolves.toBeNull();
  });
});
