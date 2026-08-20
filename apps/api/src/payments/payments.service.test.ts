import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { CategoryFeePolicy } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryFeePolicySource } from './category-fee-policy-source.js';
import { LedgerService } from './ledger.service.js';
import { PaymentIntentError } from './payment-intent.js';
import { PaymentsService } from './payments.service.js';
import type { HirePaymentInstruction } from './payments.service.js';
import {
  FakeLedgerStore,
  FakePaymentIntentStore,
  FakePaymentProvider,
} from './testing/fakes.js';

/**
 * Taking money for a hire (slice 5.2b).
 *
 * **Two things are under test and neither is the happy path.** The first is
 * *order*: the fee policy and the arithmetic come before the provider, and the
 * ledger comes before the mirror, so that every crash leaves something
 * recoverable. The second is *repetition*: a double-pressed pay button, a
 * webhook delivered twice and a reconciling read of a settled attempt must all
 * produce one charge and one ledger effect between them — §11.2's gate.
 *
 * The fakes model the database's guarantees rather than its happy path (the
 * unique attempt key, the one-capture-per-booking index), because a test that
 * passes against a fake with neither proves nothing about production.
 */

const GBP = 'GBP' as const;
const pence = (n: number): MoneyValue => Money.money(n, GBP);

const PINNED_VERSION = 'category-version-when-booked';

/** 15% owner commission, 8% renter fee — the shape §3.4 recommends. */
const PINNED_POLICY: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 500, currency: GBP },
  minimumPlatformFee: { amount: 100, currency: GBP },
};

/** A category run at cost. Legal configuration, and it used to be unpayable. */
const FREE_POLICY: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 0,
  renterFeeBasisPoints: 0,
  minimumBookingTotal: { amount: 0, currency: GBP },
  minimumPlatformFee: { amount: 0, currency: GBP },
};

/**
 * A booking's stored money: £54 of hire plus £4.32 of renter fee.
 *
 * Copied onto the booking row at the moment it was made (§8.2) — never
 * re-derived from a listing that may have been repriced since.
 */
const INSTRUCTION: HirePaymentInstruction = {
  bookingId: 'booking-1',
  ownerId: 'user-dale',
  attemptKey: 'attempt-1',
  charge: {
    itemCharge: pence(5_400),
    renterFee: pence(432),
    total: pence(5_832),
  },
  categoryVersionId: PINNED_VERSION,
  itemTitle: 'Petrol hedge trimmer',
};

class FakeFeePolicies implements CategoryFeePolicySource {
  readonly asked: string[] = [];

  constructor(private readonly policies: Record<string, CategoryFeePolicy>) {}

  findFeePolicy(categoryVersionId: string): Promise<CategoryFeePolicy | null> {
    this.asked.push(categoryVersionId);
    return Promise.resolve(this.policies[categoryVersionId] ?? null);
  }
}

let intents: FakePaymentIntentStore;
let provider: FakePaymentProvider;
let ledgerStore: FakeLedgerStore;
let ledger: LedgerService;
let feePolicies: FakeFeePolicies;
let payments: PaymentsService;

beforeEach(() => {
  intents = new FakePaymentIntentStore();
  provider = new FakePaymentProvider();
  ledgerStore = new FakeLedgerStore();
  ledger = new LedgerService(ledgerStore);
  feePolicies = new FakeFeePolicies({ [PINNED_VERSION]: PINNED_POLICY });
  payments = new PaymentsService(intents, provider, ledger, feePolicies);
});

/** What the platform holds for this owner, and what it has earned. */
async function balances(): Promise<{
  owner: number;
  revenue: number;
  clearing: number;
}> {
  const owner = await ledger.balance({
    kind: 'owner_payable',
    currency: GBP,
    ownerId: INSTRUCTION.ownerId,
  });
  const revenue = await ledger.balance({ kind: 'platform_revenue', currency: GBP });
  const clearing = await ledger.balance({ kind: 'provider_clearing', currency: GBP });
  return { owner: owner.amount, revenue: revenue.amount, clearing: clearing.amount };
}

describe('paying for a hire that succeeds at once', () => {
  it('records the attempt and posts one balanced capture', async () => {
    const { intent, payerAction } = await payments.payForHire(INSTRUCTION);

    expect(intent.status).toBe('succeeded');
    expect(intent.providerReference).toBe('fake-ref-1');
    expect(intent.provider).toBe('fake');
    expect(payerAction).toBeUndefined();

    // 15% of the £54 hire is £8.10, so the owner is owed £45.90 and the
    // platform keeps that commission plus the £4.32 renter fee.
    expect(await balances()).toEqual({
      owner: 4_590,
      revenue: 1_242,
      clearing: 5_832,
    });
  });

  it('sends the item’s name and never an address', async () => {
    await payments.payForHire(INSTRUCTION);

    // §8.4.1. This reaches a card statement, and the port says so where the
    // field is declared.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.description).toBe('Petrol hedge trimmer');
    expect(provider.requests[0]?.amount).toEqual(pence(5_832));
    expect(provider.requests[0]?.idempotencyKey).toBe('attempt-1');
  });

  it('settles a category configured to take nothing', async () => {
    /*
     * **5.2a found this and it is not hypothetical.** Fees are versioned
     * configuration and both rates may legitimately be zero — a promotional
     * category, or one run at cost. A zero share used to produce a zero-amount
     * entry that `assertPostable` refuses, which made an ordinary booking
     * unpayable. Zero shares are omitted now.
     */
    feePolicies = new FakeFeePolicies({ [PINNED_VERSION]: FREE_POLICY });
    payments = new PaymentsService(intents, provider, ledger, feePolicies);

    const { intent } = await payments.payForHire({
      ...INSTRUCTION,
      charge: {
        itemCharge: pence(5_400),
        renterFee: pence(0),
        total: pence(5_400),
      },
    });

    expect(intent.status).toBe('succeeded');
    expect(await balances()).toEqual({ owner: 5_400, revenue: 0, clearing: 5_400 });
  });

  it('records the provider’s clock as when the money moved', async () => {
    // §8.7 reconciles daily and their clock decides which day a movement belongs
    // to. One clock puts a capture at 23:59 on our side of midnight and their
    // other side, and breaks reconciliation nightly for no findable reason.
    const movedAt = new Date('2026-08-19T23:59:30.000Z');
    provider.willReport({ status: 'succeeded', occurredAt: movedAt });

    await payments.payForHire(INSTRUCTION);

    const posted = await ledgerStore.findByIdempotencyKey('hire-capture:booking-1');
    expect(posted?.occurredAt).toEqual(movedAt);
  });

  it('falls back to our clock when the provider gives none', async () => {
    const ours = new Date('2026-08-20T10:00:00.000Z');
    payments = new PaymentsService(intents, provider, ledger, feePolicies, () => ours);

    await payments.payForHire(INSTRUCTION);

    const posted = await ledgerStore.findByIdempotencyKey('hire-capture:booking-1');
    expect(posted?.occurredAt).toEqual(ours);
  });
});

describe('paying for a hire that needs the payer to act', () => {
  it('returns the challenge, posts nothing, and leaves the booking unpaid', async () => {
    // The ordinary SCA case, and the one a naive port collapses into "not paid".
    provider.willReport({
      status: 'pending_payer_action',
      payerAction: { kind: 'confirm_in_browser', token: 'secret-token' },
    });

    const { intent, payerAction } = await payments.payForHire(INSTRUCTION);

    expect(intent.status).toBe('pending_payer_action');
    expect(payerAction).toEqual({ kind: 'confirm_in_browser', token: 'secret-token' });
    expect(await balances()).toEqual({ owner: 0, revenue: 0, clearing: 0 });
  });

  it('does not store the token', async () => {
    /*
     * It is a short-lived bearer value the provider's own browser library
     * consumes. A column holding one would be a provider's format back in our
     * database, and a stale one is worse than none.
     */
    provider.willReport({
      status: 'pending_payer_action',
      payerAction: { kind: 'confirm_in_browser', token: 'secret-token' },
    });

    await payments.payForHire(INSTRUCTION);

    const [stored] = await intents.findForBooking('booking-1');
    expect(JSON.stringify(stored)).not.toContain('secret-token');
  });

  it('completes when the payer finishes and the outcome is read', async () => {
    /*
     * **The ordinary UK card journey, end to end**, and the test that found the
     * design hole this slice shipped without: the confirmation arrives with a
     * provider reference and nothing else, so the attempt row has to carry
     * everything needed to divide the money. It does now.
     */
    provider.willReport({
      status: 'pending_payer_action',
      payerAction: { kind: 'confirm_in_browser', token: 'secret-token' },
    });
    const { intent } = await payments.payForHire(INSTRUCTION);
    expect(await balances()).toEqual({ owner: 0, revenue: 0, clearing: 0 });

    provider.willReport({ status: 'succeeded' });
    const settled = await payments.refresh(intent.id);

    expect(settled?.status).toBe('succeeded');
    expect(await balances()).toEqual({
      owner: 4_590,
      revenue: 1_242,
      clearing: 5_832,
    });
  });
});

describe('paying for a hire that fails', () => {
  it('records our reason and posts nothing', async () => {
    provider.willReport({
      status: 'failed',
      failure: { reason: 'declined', message: 'Your card was declined.' },
    });

    const { intent } = await payments.payForHire(INSTRUCTION);

    expect(intent.status).toBe('failed');
    expect(intent.failure).toEqual({
      reason: 'declined',
      message: 'Your card was declined.',
    });
    expect(await balances()).toEqual({ owner: 0, revenue: 0, clearing: 0 });
  });

  it('lets a second attempt succeed under a new key', async () => {
    // A decline is terminal *for that attempt* — the provider's idempotency key
    // is per attempt, so re-presenting it would return the first failure
    // forever. The retry is a new intent.
    provider.willReport({
      status: 'failed',
      failure: { reason: 'declined', message: 'Your card was declined.' },
    });
    await payments.payForHire(INSTRUCTION);

    provider.willReport({ status: 'succeeded' });
    const { intent } = await payments.payForHire({
      ...INSTRUCTION,
      attemptKey: 'attempt-2',
    });

    expect(intent.status).toBe('succeeded');
    expect(await intents.findForBooking('booking-1')).toHaveLength(2);
    expect((await balances()).clearing).toBe(5_832);
  });
});

describe('repetition, which is what §11.2 is about', () => {
  it('charges once when pay is pressed twice', async () => {
    const first = await payments.payForHire(INSTRUCTION);
    const second = await payments.payForHire(INSTRUCTION);

    expect(second.intent.id).toBe(first.intent.id);
    // The guard that matters: the provider was called once, not twice.
    expect(provider.requests).toHaveLength(1);
    expect((await balances()).clearing).toBe(5_832);
  });

  it('posts one ledger effect however often an outcome is re-read', async () => {
    await payments.payForHire(INSTRUCTION);
    const [intent] = await intents.findForBooking('booking-1');

    for (let i = 0; i < 5; i += 1) {
      await payments.refresh(intent?.id ?? '');
    }

    expect(await balances()).toEqual({
      owner: 4_590,
      revenue: 1_242,
      clearing: 5_832,
    });
    // A settled attempt is not re-read at all, which saves a provider call on
    // every duplicate webhook.
    expect(provider.reads).toHaveLength(0);
  });

  it('refuses an outcome that contradicts a settled one', async () => {
    /*
     * **Out-of-order delivery, which providers do not rule out.** A `failed`
     * arriving after a `succeeded` must not unsettle a captured hire — and it
     * must not silently pass either, because it means the provider has reported
     * two endings for one attempt.
     */
    provider.willReport({ status: 'processing' });
    const { intent } = await payments.payForHire(INSTRUCTION);

    provider.willReport({ status: 'succeeded' });
    await payments.refresh(intent.id);

    provider.willReport({
      status: 'failed',
      failure: { reason: 'declined', message: 'no' },
    });
    // The short-circuit answers first: a settled attempt is not re-read at all.
    const settled = await payments.refresh(intent.id);
    expect(settled?.status).toBe('succeeded');
    expect((await balances()).clearing).toBe(5_832);
  });

  it('does not call the provider for an attempt that never reached it', async () => {
    const intent = await intents.begin({
      bookingId: 'booking-1',
      purpose: 'hire_charge',
      attemptKey: 'attempt-orphan',
      ownerId: INSTRUCTION.ownerId,
      categoryVersionId: PINNED_VERSION,
      itemCharge: pence(5_400),
      renterFee: pence(432),
      amount: pence(5_832),
      provider: 'fake',
    });

    const refreshed = await payments.refresh(intent.id);

    // There is no reference to look one up by. Inventing one would be a lie,
    // and the retry path — same key, `initiated` — is what exists for this.
    expect(refreshed?.status).toBe('initiated');
    expect(provider.reads).toHaveLength(0);
  });

  it('resolves to null for an attempt that does not exist', async () => {
    expect(await payments.refresh('no-such-intent')).toBeNull();
  });
});

describe('refusing before the money moves', () => {
  it('refuses a booking whose pinned category version cannot be found', async () => {
    /*
     * **Never a fallback to the current version.** §8.2 binds a booking to the
     * terms it was made under, and today's rates would pay an owner a number
     * nobody agreed to — silently, with every other test still green.
     */
    await expect(async () => {
      await payments.payForHire({ ...INSTRUCTION, categoryVersionId: 'gone' });
    }).rejects.toThrow(PaymentIntentError);

    expect(provider.requests).toHaveLength(0);
    expect(await intents.findForBooking('booking-1')).toHaveLength(0);
  });

  it('refuses a booking row that disagrees with itself', async () => {
    // `settleHire` catches this, and catching it *before* the provider is what
    // turns a permanent ledger error into a refusal nobody paid for.
    await expect(async () => {
      await payments.payForHire({
        ...INSTRUCTION,
        charge: {
          itemCharge: pence(5_400),
          renterFee: pence(432),
          total: pence(9_999),
        },
      });
    }).rejects.toThrow(/is not its parts/);

    expect(provider.requests).toHaveLength(0);
  });

  it('asks for the pinned version and never the current one', async () => {
    await payments.payForHire(INSTRUCTION);

    /*
     * **Asked twice on the paying path, and that is intended.** Once as the gate
     * that refuses before the provider is called, once from the attempt's own
     * stored terms when the money has moved — the second being the only one an
     * out-of-band confirmation can reach. What matters is that every ask names
     * the version the booking pinned; a `currentCategoryVersionId` appearing
     * here would mean an owner paid a rate nobody agreed to.
     */
    expect(feePolicies.asked).not.toHaveLength(0);
    expect(new Set(feePolicies.asked)).toEqual(new Set([PINNED_VERSION]));
  });
});

describe('reading a booking’s attempts', () => {
  it('returns every attempt, newest first', async () => {
    provider.willReport({
      status: 'failed',
      failure: { reason: 'declined', message: 'no' },
    });
    await payments.payForHire(INSTRUCTION);

    provider.willReport({ status: 'succeeded' });
    await payments.payForHire({ ...INSTRUCTION, attemptKey: 'attempt-2' });

    const attempts = await payments.attemptsFor('booking-1');
    expect(attempts.map((attempt) => attempt.attemptKey)).toEqual([
      'attempt-2',
      'attempt-1',
    ]);
  });
});
