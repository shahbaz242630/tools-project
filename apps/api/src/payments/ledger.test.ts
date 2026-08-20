import { describe, expect, it } from 'vitest';
import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import {
  LEDGER_ACCOUNT_KINDS,
  LEDGER_DIRECTIONS,
  LEDGER_TRANSACTION_KINDS,
  LedgerError,
  accountIdentityOf,
  apportion,
  assertPostable,
  balanceOf,
  holderOf,
  normalSideOf,
  oppositeOf,
  reversalOf,
  totalsOf,
} from './ledger.js';
import type {
  LedgerEntryDraft,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from './ledger.js';

/**
 * The double-entry primitives (slice 5.1).
 *
 * **The failure this file exists to prevent is not a wrong number — it is a
 * ledger that stops balancing and cannot be unpicked afterwards.** An unbalanced
 * transaction leaves no evidence of what it should have been, so every rule is
 * tested at its boundary rather than at a comfortable value, and the reversal
 * tests assert the property that matters (*every account it touched returns to
 * where it was*) rather than a shape.
 */

const GBP = 'GBP' as const;
const pence = (n: number): MoneyValue => Money.money(n, GBP);

const PROVIDER = 'acct-provider-clearing';
const OWNER = 'acct-owner-payable';
const REVENUE = 'acct-platform-revenue';

/** A balanced three-way marketplace split: £19.44 in, £15.12 out, £4.32 kept. */
function captureDraft(
  overrides: Partial<LedgerTransactionDraft> = {},
): LedgerTransactionDraft {
  return {
    idempotencyKey: 'capture-booking-1',
    kind: 'hire_charge_captured',
    currency: GBP,
    bookingId: 'booking-1',
    occurredAt: new Date('2026-09-15T10:00:00.000Z'),
    entries: [
      { accountId: PROVIDER, direction: 'debit', amount: pence(1944) },
      { accountId: OWNER, direction: 'credit', amount: pence(1512) },
      { accountId: REVENUE, direction: 'credit', amount: pence(432) },
    ],
    ...overrides,
  };
}

describe('the vocabularies', () => {
  it('has exactly two directions, because a third would have no meaning', () => {
    expect([...LEDGER_DIRECTIONS]).toEqual(['debit', 'credit']);
  });

  it('gives every account kind a normal side', () => {
    for (const kind of LEDGER_ACCOUNT_KINDS) {
      expect(LEDGER_DIRECTIONS).toContain(normalSideOf(kind));
    }
  });

  it('gives every account kind a holder', () => {
    for (const kind of LEDGER_ACCOUNT_KINDS) {
      expect(['platform', 'user']).toContain(holderOf(kind));
    }
  });

  it('holds the money owed to a person on a per-user account', () => {
    // The one that would be silently wrong the other way: a single platform-wide
    // `owner_payable` would net every owner's balance against every other's.
    expect(holderOf('owner_payable')).toBe('user');
    expect(holderOf('provider_clearing')).toBe('platform');
    expect(holderOf('platform_revenue')).toBe('platform');
  });

  it('increases assets by debit and liabilities and revenue by credit', () => {
    expect(normalSideOf('provider_clearing')).toBe('debit');
    expect(normalSideOf('owner_payable')).toBe('credit');
    expect(normalSideOf('platform_revenue')).toBe('credit');
  });

  it('does not name a correction as a transaction kind', () => {
    // A reversal keeps the kind of what it reverses — see `reversalOf`.
    expect([...LEDGER_TRANSACTION_KINDS]).not.toContain('correction');
    expect([...LEDGER_TRANSACTION_KINDS]).not.toContain('reversal');
  });

  it('flips a direction to its opposite and back', () => {
    for (const direction of LEDGER_DIRECTIONS) {
      expect(oppositeOf(oppositeOf(direction))).toBe(direction);
      expect(oppositeOf(direction)).not.toBe(direction);
    }
  });
});

describe('accountIdentityOf', () => {
  it('distinguishes two people holding the same kind of account', () => {
    expect(
      accountIdentityOf({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).not.toBe(
      accountIdentityOf({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: 'user-priya',
      }),
    );
  });

  it('gives the platform one account per kind and currency', () => {
    // The case a composite unique on (kind, ownerId, currency) would miss
    // entirely, because Postgres treats NULLs as distinct: two rows, one balance
    // split between them, and nothing complaining.
    expect(accountIdentityOf({ kind: 'provider_clearing', currency: GBP })).toBe(
      accountIdentityOf({ kind: 'provider_clearing', currency: GBP }),
    );
  });

  it('distinguishes kinds from each other', () => {
    expect(accountIdentityOf({ kind: 'provider_clearing', currency: GBP })).not.toBe(
      accountIdentityOf({ kind: 'platform_revenue', currency: GBP }),
    );
  });

  it('refuses a per-person kind with no owner', () => {
    expect(() => accountIdentityOf({ kind: 'owner_payable', currency: GBP })).toThrow(
      /needs an owner/,
    );
  });

  it('refuses a per-person kind with a blank owner', () => {
    expect(() =>
      accountIdentityOf({
        kind: 'owner_payable',
        currency: GBP,
        ownerId: '  ',
      }),
    ).toThrow(/needs an owner/);
  });

  it('refuses attributing a platform kind to a person', () => {
    expect(() =>
      accountIdentityOf({
        kind: 'platform_revenue',
        currency: GBP,
        ownerId: 'user-dale',
      }),
    ).toThrow(/cannot be attributed to a person/);
  });
});

describe('totalsOf', () => {
  it('sums each side independently', () => {
    const { debits, credits } = totalsOf(captureDraft());
    expect(debits).toEqual(pence(1944));
    expect(credits).toEqual(pence(1944));
  });

  it('reports zero on a side with no entries rather than throwing', () => {
    const { debits, credits } = totalsOf(
      captureDraft({
        entries: [{ accountId: PROVIDER, direction: 'debit', amount: pence(100) }],
      }),
    );
    expect(debits).toEqual(pence(100));
    expect(credits).toEqual(pence(0));
  });
});

describe('assertPostable', () => {
  it('accepts a balanced three-way split', () => {
    expect(() => assertPostable(captureDraft())).not.toThrow();
  });

  it('accepts a balanced two-entry payout', () => {
    expect(() =>
      assertPostable(
        captureDraft({
          kind: 'owner_payout',
          idempotencyKey: 'payout-1',
          entries: [
            { accountId: OWNER, direction: 'debit', amount: pence(1512) },
            { accountId: PROVIDER, direction: 'credit', amount: pence(1512) },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a transaction whose sides differ by a single penny', () => {
    // One penny is the whole point: a large error is noticed and a penny is not.
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [
            { accountId: PROVIDER, direction: 'debit', amount: pence(1944) },
            { accountId: OWNER, direction: 'credit', amount: pence(1512) },
            { accountId: REVENUE, direction: 'credit', amount: pence(431) },
          ],
        }),
      ),
    ).toThrow(LedgerError);
  });

  it('names both sides when it refuses, so the error is actionable', () => {
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [
            { accountId: PROVIDER, direction: 'debit', amount: pence(1944) },
            { accountId: OWNER, direction: 'credit', amount: pence(1943) },
          ],
        }),
      ),
    ).toThrow(/1944.*1943|1943.*1944/);
  });

  it('refuses a single entry, which can never balance', () => {
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [{ accountId: PROVIDER, direction: 'debit', amount: pence(100) }],
        }),
      ),
    ).toThrow(/at least two entries/);
  });

  it('refuses no entries at all', () => {
    expect(() => assertPostable(captureDraft({ entries: [] }))).toThrow(LedgerError);
  });

  it('refuses a zero amount, which records nothing', () => {
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [
            { accountId: PROVIDER, direction: 'debit', amount: pence(0) },
            { accountId: OWNER, direction: 'credit', amount: pence(0) },
          ],
        }),
      ),
    ).toThrow(/must be positive/);
  });

  it('refuses a negative amount even when the transaction still balances', () => {
    // This is the subtle one. Debits -100 and credits -100 balance perfectly and
    // are the same movement written backwards; admitting both conventions makes
    // every later sum ambiguous. ADR 0002 permits negative Money — a ledger entry
    // is where that permission stops.
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [
            { accountId: PROVIDER, direction: 'debit', amount: pence(-100) },
            { accountId: OWNER, direction: 'credit', amount: pence(-100) },
          ],
        }),
      ),
    ).toThrow(/direction carries the sign/);
  });

  it('refuses a fractional minor unit', () => {
    // Built by hand rather than through `money()`, which refuses it first. The
    // ledger cannot rely on that: a row read back out of the database arrives as
    // a plain object and never passes through the constructor.
    const fractional = { amount: 100.5, currency: GBP } as MoneyValue;
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [
            { accountId: PROVIDER, direction: 'debit', amount: fractional },
            { accountId: OWNER, direction: 'credit', amount: fractional },
          ],
        }),
      ),
    ).toThrow(/whole minor units/);
  });

  it('refuses an entry denominated in another currency', () => {
    const foreign = { amount: 100, currency: 'EUR' } as unknown as MoneyValue;
    expect(() =>
      assertPostable(
        captureDraft({
          entries: [
            { accountId: PROVIDER, direction: 'debit', amount: pence(100) },
            { accountId: OWNER, direction: 'credit', amount: foreign },
          ],
        }),
      ),
    ).toThrow(/does not match transaction currency/);
  });

  it('refuses an empty idempotency key, because it would deduplicate nothing', () => {
    expect(() => assertPostable(captureDraft({ idempotencyKey: '   ' }))).toThrow(
      /idempotency key/,
    );
  });
});

describe('reversalOf', () => {
  const posted: PostedLedgerTransaction = {
    ...captureDraft(),
    id: 'txn-1',
    recordedAt: new Date('2026-09-15T10:00:01.000Z'),
  };

  const reversal = reversalOf(posted, {
    idempotencyKey: 'correct-capture-booking-1',
    occurredAt: new Date('2026-09-22T09:00:00.000Z'),
  });

  it('produces a transaction that itself balances', () => {
    expect(() => assertPostable(reversal)).not.toThrow();
  });

  it('flips every direction and keeps every amount and account', () => {
    expect(reversal.entries).toEqual([
      { accountId: PROVIDER, direction: 'credit', amount: pence(1944) },
      { accountId: OWNER, direction: 'debit', amount: pence(1512) },
      { accountId: REVENUE, direction: 'debit', amount: pence(432) },
    ]);
  });

  it('returns every account it touched to where it started', () => {
    // The property that actually matters, asserted rather than inferred from
    // shape: after the pair, each account nets to zero.
    for (const [accountId, kind] of [
      [PROVIDER, 'provider_clearing'],
      [OWNER, 'owner_payable'],
      [REVENUE, 'platform_revenue'],
    ] as const) {
      const both = [...posted.entries, ...reversal.entries].filter(
        (entry) => entry.accountId === accountId,
      );
      expect(balanceOf(kind, GBP, both)).toEqual(pence(0));
    }
  });

  it('names the transaction it reverses', () => {
    expect(reversal.reversesTransactionId).toBe('txn-1');
  });

  it('keeps the kind of what it reverses rather than inventing one', () => {
    expect(reversal.kind).toBe(posted.kind);
  });

  it('takes its own occurrence time, because a correction happened later', () => {
    expect(reversal.occurredAt).toEqual(new Date('2026-09-22T09:00:00.000Z'));
    expect(reversal.occurredAt).not.toEqual(posted.occurredAt);
  });

  it('takes a new idempotency key rather than reusing the original', () => {
    expect(reversal.idempotencyKey).not.toBe(posted.idempotencyKey);
  });

  it('carries the booking through, so a correction is still about that hire', () => {
    expect(reversal.bookingId).toBe('booking-1');
  });

  it('omits the booking entirely when the original had none', () => {
    // Built field by field rather than spread-and-override: under
    // `exactOptionalPropertyTypes` an explicit `bookingId: undefined` is not the
    // same as an absent key, and absent is what this test is about.
    const withoutBooking: PostedLedgerTransaction = {
      id: posted.id,
      recordedAt: posted.recordedAt,
      idempotencyKey: posted.idempotencyKey,
      kind: posted.kind,
      currency: posted.currency,
      occurredAt: posted.occurredAt,
      entries: posted.entries,
    };
    const corrected = reversalOf(withoutBooking, {
      idempotencyKey: 'k',
      occurredAt: new Date('2026-09-22T09:00:00.000Z'),
    });
    expect('bookingId' in corrected).toBe(false);
  });

  it('can reverse a reversal, which points at the correction not the original', () => {
    const postedReversal: PostedLedgerTransaction = {
      ...reversal,
      id: 'txn-2',
      recordedAt: new Date('2026-09-22T09:00:01.000Z'),
    };
    const undone = reversalOf(postedReversal, {
      idempotencyKey: 'undo-the-correction',
      occurredAt: new Date('2026-09-23T09:00:00.000Z'),
    });

    expect(undone.reversesTransactionId).toBe('txn-2');
    expect(undone.entries).toEqual(posted.entries);
  });
});

describe('balanceOf', () => {
  it('is positive towards the normal side', () => {
    expect(
      balanceOf('owner_payable', GBP, [{ direction: 'credit', amount: pence(1512) }]),
    ).toEqual(pence(1512));

    expect(
      balanceOf('provider_clearing', GBP, [
        { direction: 'debit', amount: pence(1944) },
      ]),
    ).toEqual(pence(1944));
  });

  it('nets a payout against a capture', () => {
    expect(
      balanceOf('owner_payable', GBP, [
        { direction: 'credit', amount: pence(1512) },
        { direction: 'debit', amount: pence(1512) },
      ]),
    ).toEqual(pence(0));
  });

  it('goes negative rather than clamping, because §8.7 names negative balances', () => {
    expect(
      balanceOf('owner_payable', GBP, [
        { direction: 'credit', amount: pence(1000) },
        { direction: 'debit', amount: pence(1500) },
      ]),
    ).toEqual(pence(-500));
  });

  it('is zero for an account with no entries', () => {
    expect(balanceOf('platform_revenue', GBP, [])).toEqual(pence(0));
  });
});

describe('apportion', () => {
  it('builds a balanced set from a movement and its shares', () => {
    const entries = apportion({
      currency: GBP,
      from: { accountId: PROVIDER, amount: pence(1944) },
      to: [
        { accountId: OWNER, amount: pence(1512) },
        { accountId: REVENUE, amount: pence(432) },
      ],
    });

    expect(() => assertPostable(captureDraft({ entries }))).not.toThrow();
  });

  it('accepts what allocate produces, including the awkward remainder', () => {
    // ADR 0002's conservation property meeting this one: whatever `allocate`
    // returns must be postable, or the two rules disagree and the ledger loses.
    const total = pence(1001);
    const shares = Money.allocate(total, [85, 15]);

    const entries: LedgerEntryDraft[] = apportion({
      currency: GBP,
      from: { accountId: PROVIDER, amount: total },
      to: shares.map((amount, index) => ({
        accountId: index === 0 ? OWNER : REVENUE,
        amount,
      })),
    });

    expect(() => assertPostable(captureDraft({ entries }))).not.toThrow();
  });

  it('refuses shares that do not sum to what moved', () => {
    expect(() =>
      apportion({
        currency: GBP,
        from: { accountId: PROVIDER, amount: pence(1944) },
        to: [
          { accountId: OWNER, amount: pence(1512) },
          { accountId: REVENUE, amount: pence(431) },
        ],
      }),
    ).toThrow(/do not sum to/);
  });

  it('refuses shares that overshoot as readily as ones that undershoot', () => {
    expect(() =>
      apportion({
        currency: GBP,
        from: { accountId: PROVIDER, amount: pence(100) },
        to: [{ accountId: OWNER, amount: pence(101) }],
      }),
    ).toThrow(LedgerError);
  });
});
