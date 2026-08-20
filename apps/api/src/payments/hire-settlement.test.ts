import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { LedgerError, assertPostable } from './ledger.js';
import { hireCaptureEntries, settleHire } from './hire-settlement.js';
import type { HireCharge } from './hire-settlement.js';

/**
 * Dividing a hire's money (slice 5.2a).
 *
 * **The property that matters is conservation**, and it is tested the way ADR
 * 0002 tests `allocate`: across a sweep of amounts and rates rather than at a
 * handful of comfortable numbers. A penny invented or lost here becomes a ledger
 * that does not balance, and §8.7 makes it permanent.
 */

const GBP = 'GBP' as const;
const pence = (n: number): MoneyValue => Money.money(n, GBP);

function policy(ownerBasisPoints: number, renterBasisPoints = 800): CategoryFeePolicy {
  return {
    ownerCommissionBasisPoints: ownerBasisPoints,
    renterFeeBasisPoints: renterBasisPoints,
    minimumBookingTotal: pence(1_000),
    minimumPlatformFee: pence(100),
  };
}

/** A charge whose total is genuinely its parts, as the quote engine writes it. */
function charge(itemCharge: number, renterFee: number): HireCharge {
  return {
    itemCharge: pence(itemCharge),
    renterFee: pence(renterFee),
    total: pence(itemCharge + renterFee),
  };
}

describe('settleHire', () => {
  it('divides the fixture hire the way the handoff describes it', () => {
    // The hedge trimmer: £18.00 + £1.44 renter fee = £19.44, 16% owner commission.
    const settled = settleHire(charge(1800, 144), policy(1600));

    expect(settled.renterPays).toEqual(pence(1944));
    expect(settled.ownerCommission).toEqual(pence(288));
    expect(settled.ownerEarns).toEqual(pence(1512));
    expect(settled.platformEarns).toEqual(pence(432));
  });

  it('gives the platform the renter fee plus the owner commission', () => {
    const settled = settleHire(charge(1800, 144), policy(1600));
    expect(settled.platformEarns).toEqual(
      Money.add(pence(144), settled.ownerCommission),
    );
  });

  it('conserves every penny across a sweep of amounts and rates', () => {
    // The test ADR 0002 would want. Independently rounding both shares passes at
    // round numbers and fails somewhere in here.
    for (let itemCharge = 1_000; itemCharge <= 40_000; itemCharge += 137) {
      for (const ownerRate of [0, 1, 799, 1_200, 1_600, 1_850, 2_000]) {
        const renterFee = Money.percentageOf(pence(itemCharge), 8).amount;
        const hire = charge(itemCharge, renterFee);
        const settled = settleHire(hire, policy(ownerRate));

        expect(Money.add(settled.ownerEarns, settled.platformEarns)).toEqual(
          settled.renterPays,
        );
      }
    }
  });

  it('never pays an owner more than the item charge', () => {
    for (const ownerRate of [0, 500, 1_600, 2_000]) {
      const settled = settleHire(charge(1799, 144), policy(ownerRate));
      expect(settled.ownerEarns.amount).toBeLessThanOrEqual(1799);
    }
  });

  it('takes nothing from the owner at a zero commission', () => {
    const settled = settleHire(charge(1800, 144), policy(0));

    expect(settled.ownerCommission).toEqual(pence(0));
    expect(settled.ownerEarns).toEqual(pence(1800));
    expect(settled.platformEarns).toEqual(pence(144));
  });

  it('earns the platform nothing when both rates are zero', () => {
    // Configuration permits it, so it must settle rather than throw.
    const settled = settleHire(charge(1800, 0), policy(0, 0));

    expect(settled.ownerEarns).toEqual(pence(1800));
    expect(settled.platformEarns).toEqual(pence(0));
  });

  it('refuses a row whose total is not its own parts', () => {
    // A booking row that disagrees with itself. Posting from it would put the
    // error in the ledger, where §8.7 makes it permanent.
    expect(() =>
      settleHire(
        {
          itemCharge: pence(1800),
          renterFee: pence(144),
          total: pence(1900),
        },
        policy(1600),
      ),
    ).toThrow(/is not its parts/);
  });

  it('refuses amounts in different currencies', () => {
    const euros = { amount: 144, currency: 'EUR' } as unknown as MoneyValue;
    expect(() =>
      settleHire(
        { itemCharge: pence(1800), renterFee: euros, total: pence(1944) },
        policy(1600),
      ),
    ).toThrow(LedgerError);
  });
});

describe('hireCaptureEntries', () => {
  const accounts = {
    providerClearingAccountId: 'acct-provider',
    ownerPayableAccountId: 'acct-owner',
    platformRevenueAccountId: 'acct-revenue',
  };

  it('produces a posting that balances', () => {
    const entries = hireCaptureEntries({
      settlement: settleHire(charge(1800, 144), policy(1600)),
      ...accounts,
    });

    expect(() =>
      assertPostable({
        idempotencyKey: 'k',
        kind: 'hire_charge_captured',
        currency: GBP,
        occurredAt: new Date('2026-09-15T10:00:00.000Z'),
        entries,
      }),
    ).not.toThrow();
  });

  it('debits the provider and credits the owner and the platform', () => {
    const entries = hireCaptureEntries({
      settlement: settleHire(charge(1800, 144), policy(1600)),
      ...accounts,
    });

    expect(entries).toEqual([
      { accountId: 'acct-provider', direction: 'debit', amount: pence(1944) },
      { accountId: 'acct-owner', direction: 'credit', amount: pence(1512) },
      { accountId: 'acct-revenue', direction: 'credit', amount: pence(432) },
    ]);
  });

  it('omits a zero platform share rather than posting an unpostable entry', () => {
    // The case that would otherwise make a legitimate booking unpayable: a
    // category configured with no fees at all.
    const entries = hireCaptureEntries({
      settlement: settleHire(charge(1800, 0), policy(0, 0)),
      ...accounts,
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.accountId)).not.toContain('acct-revenue');
    expect(() =>
      assertPostable({
        idempotencyKey: 'k',
        kind: 'hire_charge_captured',
        currency: GBP,
        occurredAt: new Date('2026-09-15T10:00:00.000Z'),
        entries,
      }),
    ).not.toThrow();
  });

  it('stays postable across the whole sweep', () => {
    for (let itemCharge = 1_000; itemCharge <= 20_000; itemCharge += 211) {
      for (const ownerRate of [0, 750, 1_600, 2_000]) {
        const renterFee = Money.percentageOf(pence(itemCharge), 8).amount;
        const entries = hireCaptureEntries({
          settlement: settleHire(charge(itemCharge, renterFee), policy(ownerRate)),
          ...accounts,
        });

        expect(() =>
          assertPostable({
            idempotencyKey: 'k',
            kind: 'hire_charge_captured',
            currency: GBP,
            occurredAt: new Date('2026-09-15T10:00:00.000Z'),
            entries,
          }),
        ).not.toThrow();
      }
    }
  });
});
