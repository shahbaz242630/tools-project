import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerError, apportion } from './ledger.js';
import type { LedgerTransactionDraft } from './ledger.js';
import { LedgerService } from './ledger.service.js';
import { FakeLedgerStore } from './testing/fakes.js';

/**
 * Posting to the books (slice 5.1).
 *
 * **The behaviour under test is idempotency, and its two halves pull in opposite
 * directions.** Re-presenting a key must return what was written — §11.2's
 * *"duplicate and out-of-order provider webhooks produce exactly one ledger
 * effect"*. Re-presenting a key for *different money* must throw, because the
 * caller believes it posted what it passed and silently returning something else
 * is the failure mode idempotency is supposed to prevent, wearing its clothes.
 */

const GBP = 'GBP' as const;
const pence = (n: number): MoneyValue => Money.money(n, GBP);

const RENTER_TOTAL = pence(1944);
const OWNER_SHARE = pence(1512);
const PLATFORM_SHARE = pence(432);

let store: FakeLedgerStore;
let ledger: LedgerService;

beforeEach(() => {
  store = new FakeLedgerStore();
  ledger = new LedgerService(store);
});

/** The three accounts a hire capture touches. */
async function accounts(): Promise<{
  provider: string;
  owner: string;
  revenue: string;
}> {
  const provider = await ledger.accountFor({
    kind: 'provider_clearing',
    currency: GBP,
  });
  const owner = await ledger.accountFor({
    kind: 'owner_payable',
    currency: GBP,
    ownerId: 'user-dale',
  });
  const revenue = await ledger.accountFor({
    kind: 'platform_revenue',
    currency: GBP,
  });
  return { provider: provider.id, owner: owner.id, revenue: revenue.id };
}

async function captureDraft(
  overrides: Partial<LedgerTransactionDraft> = {},
): Promise<LedgerTransactionDraft> {
  const { provider, owner, revenue } = await accounts();
  return {
    idempotencyKey: 'capture-booking-1',
    kind: 'hire_charge_captured',
    currency: GBP,
    bookingId: 'booking-1',
    occurredAt: new Date('2026-09-15T10:00:00.000Z'),
    entries: apportion({
      currency: GBP,
      from: { accountId: provider, amount: RENTER_TOTAL },
      to: [
        { accountId: owner, amount: OWNER_SHARE },
        { accountId: revenue, amount: PLATFORM_SHARE },
      ],
    }),
    ...overrides,
  };
}

describe('accountFor', () => {
  it('creates an account once and returns the same one after', async () => {
    const first = await ledger.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId: 'user-dale',
    });
    const second = await ledger.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId: 'user-dale',
    });

    expect(second.id).toBe(first.id);
  });

  it('keeps two people on two accounts', async () => {
    const dale = await ledger.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId: 'user-dale',
    });
    const priya = await ledger.accountFor({
      kind: 'owner_payable',
      currency: GBP,
      ownerId: 'user-priya',
    });

    expect(priya.id).not.toBe(dale.id);
  });

  it('refuses a per-person account with nobody attached', async () => {
    await expect(
      ledger.accountFor({ kind: 'owner_payable', currency: GBP }),
    ).rejects.toThrow(/needs an owner/);
  });

  it('refuses attributing a platform account to a person', async () => {
    await expect(
      ledger.accountFor({
        kind: 'provider_clearing',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).rejects.toThrow(/cannot be attributed to a person/);
  });
});

describe('post', () => {
  it('writes a balanced capture', async () => {
    const posted = await ledger.post(await captureDraft());

    expect(posted.id).toBeTruthy();
    expect(posted.entries).toHaveLength(3);
    expect(store.posted).toHaveLength(1);
  });

  it('refuses an unbalanced transaction before it reaches the store', async () => {
    const { provider, owner } = await accounts();

    await expect(
      ledger.post({
        idempotencyKey: 'wrong',
        kind: 'hire_charge_captured',
        currency: GBP,
        occurredAt: new Date(),
        entries: [
          { accountId: provider, direction: 'debit', amount: pence(1944) },
          { accountId: owner, direction: 'credit', amount: pence(1943) },
        ],
      }),
    ).rejects.toThrow(LedgerError);

    expect(store.posted).toHaveLength(0);
  });

  it('posts once when the same key arrives twice', async () => {
    const draft = await captureDraft();

    const first = await ledger.post(draft);
    const second = await ledger.post(draft);

    expect(second.id).toBe(first.id);
    expect(store.posted).toHaveLength(1);
  });

  it('is unmoved by the entries arriving in a different order', async () => {
    // The same transaction assembled by a caller that listed the platform's share
    // before the owner's. Order carries no meaning, so this must not read as a
    // different transaction.
    const draft = await captureDraft();
    const first = await ledger.post(draft);

    const reordered = { ...draft, entries: [...draft.entries].reverse() };
    const second = await ledger.post(reordered);

    expect(second.id).toBe(first.id);
    expect(store.posted).toHaveLength(1);
  });

  it('refuses a key reused for a different amount', async () => {
    const draft = await captureDraft();
    await ledger.post(draft);

    const { provider, owner, revenue } = await accounts();
    await expect(
      ledger.post({
        ...draft,
        entries: apportion({
          currency: GBP,
          from: { accountId: provider, amount: pence(2000) },
          to: [
            { accountId: owner, amount: pence(1568) },
            { accountId: revenue, amount: pence(432) },
          ],
        }),
      }),
    ).rejects.toThrow(/already been used for a different transaction/);
  });

  it('refuses a key reused against a different booking', async () => {
    const draft = await captureDraft();
    await ledger.post(draft);

    await expect(ledger.post({ ...draft, bookingId: 'booking-2' })).rejects.toThrow(
      /already been used/,
    );
  });

  it('refuses a key reused for a different kind of transaction', async () => {
    const draft = await captureDraft();
    await ledger.post(draft);

    await expect(ledger.post({ ...draft, kind: 'owner_payout' })).rejects.toThrow(
      /already been used/,
    );
  });
});

describe('balance', () => {
  it('is zero for an account nothing has posted to', async () => {
    await expect(
      ledger.balance({ kind: 'platform_revenue', currency: GBP }),
    ).resolves.toEqual(pence(0));
  });

  it('shows what the platform owes an owner after a capture', async () => {
    await ledger.post(await captureDraft());

    await expect(
      ledger.balance({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).resolves.toEqual(OWNER_SHARE);
  });

  it('shows the platform holding the whole renter total at the provider', async () => {
    await ledger.post(await captureDraft());

    await expect(
      ledger.balance({ kind: 'provider_clearing', currency: GBP }),
    ).resolves.toEqual(RENTER_TOTAL);
  });

  it('returns to nothing owed once the owner is paid out', async () => {
    await ledger.post(await captureDraft());
    const { provider, owner } = await accounts();

    await ledger.post({
      idempotencyKey: 'payout-1',
      kind: 'owner_payout',
      currency: GBP,
      occurredAt: new Date('2026-09-20T10:00:00.000Z'),
      entries: [
        { accountId: owner, direction: 'debit', amount: OWNER_SHARE },
        { accountId: provider, direction: 'credit', amount: OWNER_SHARE },
      ],
    });

    await expect(
      ledger.balance({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).resolves.toEqual(pence(0));

    // And the platform's own fee is still sitting at the provider.
    await expect(
      ledger.balance({ kind: 'provider_clearing', currency: GBP }),
    ).resolves.toEqual(PLATFORM_SHARE);
  });
});

describe('reverse', () => {
  it('returns every account to where it started', async () => {
    const posted = await ledger.post(await captureDraft());

    await ledger.reverse(posted.id, {
      idempotencyKey: 'correct-capture-booking-1',
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
    });

    await expect(
      ledger.balance({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).resolves.toEqual(pence(0));
    await expect(
      ledger.balance({ kind: 'provider_clearing', currency: GBP }),
    ).resolves.toEqual(pence(0));
    await expect(
      ledger.balance({ kind: 'platform_revenue', currency: GBP }),
    ).resolves.toEqual(pence(0));
  });

  it('leaves both the mistake and its correction in the ledger', async () => {
    const posted = await ledger.post(await captureDraft());
    await ledger.reverse(posted.id, {
      idempotencyKey: 'correction',
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
    });

    // §8.7: nothing is edited and nothing is deleted. Two transactions, not one
    // amended one — that is what makes the ledger evidence.
    expect(store.posted).toHaveLength(2);
    expect(store.posted[0]?.id).toBe(posted.id);
  });

  it('records what it reversed and keeps that transaction’s kind', async () => {
    const posted = await ledger.post(await captureDraft());
    const correction = await ledger.reverse(posted.id, {
      idempotencyKey: 'correction',
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
    });

    expect(correction.reversesTransactionId).toBe(posted.id);
    expect(correction.kind).toBe('hire_charge_captured');
  });

  it('refuses to reverse a transaction that does not exist', async () => {
    await expect(
      ledger.reverse('nope', {
        idempotencyKey: 'k',
        occurredAt: new Date(),
      }),
    ).rejects.toThrow(/no such ledger transaction/);
  });

  it('refuses a second, different correction of the same transaction', async () => {
    const posted = await ledger.post(await captureDraft());
    await ledger.reverse(posted.id, {
      idempotencyKey: 'correction-1',
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
    });

    await expect(
      ledger.reverse(posted.id, {
        idempotencyKey: 'correction-2',
        occurredAt: new Date('2026-09-23T09:00:00.000Z'),
      }),
    ).rejects.toThrow(/already been reversed/);
  });

  it('is idempotent when the same correction is submitted twice', async () => {
    const posted = await ledger.post(await captureDraft());
    const correction = { idempotencyKey: 'c', occurredAt: new Date() };

    const first = await ledger.reverse(posted.id, correction);
    const second = await ledger.reverse(posted.id, correction);

    expect(second.id).toBe(first.id);
    expect(store.posted).toHaveLength(2);
  });

  it('can reverse a correction, which undoes the undo', async () => {
    const posted = await ledger.post(await captureDraft());
    const correction = await ledger.reverse(posted.id, {
      idempotencyKey: 'correction',
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
    });

    await ledger.reverse(correction.id, {
      idempotencyKey: 'undo-the-correction',
      occurredAt: new Date('2026-09-23T09:00:00.000Z'),
    });

    await expect(
      ledger.balance({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).resolves.toEqual(OWNER_SHARE);
  });
});
