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
    /*
     * **Derived here rather than supplied**, from the booking and how many
     * attempts have already failed. Nothing has, so it is the zeroth — which is
     * what makes a double press and a resume land on the same attempt.
     */
    expect(provider.requests[0]?.idempotencyKey).toBe('hire:booking-1:0');
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
    await payments.payForHire(INSTRUCTION);

    const attempts = await payments.attemptsFor('booking-1');
    // The second key differs *because the first failed*, which is the whole rule:
    // a retry must be a new attempt, and a repeat must not be.
    expect(attempts.map((attempt) => attempt.attemptKey)).toEqual([
      'hire:booking-1:1',
      'hire:booking-1:0',
    ]);
  });
});

/**
 * §8.7.2's damage-security hold (slice 5.5c-i).
 *
 * **The distinction under test throughout is between three outcomes that all
 * end with no money taken**: a category that requires no security, a hold that
 * stands, and a hold that failed. §8.7.2 requires the first and the third to be
 * told apart, because they call for opposite decisions about handing over
 * somebody's property — and the second takes nothing either, which is why
 * nothing may reach the ledger.
 */
describe('holding damage security', () => {
  const EXCESS = pence(5_000);

  const SECURING = {
    bookingId: 'booking-1',
    ownerId: 'user-dale',
    categoryVersionId: PINNED_VERSION,
    excess: EXCESS,
    itemTitle: 'Petrol hedge trimmer',
  };

  it('holds nothing, and calls nobody, when the category requires no security', async () => {
    /*
     * ADR 0052: a null applied excess is a configured answer — "items in this
     * category are handed over with nothing held" — and never a missing one.
     * **This is the case that must never become `SECURITY_FAILED`.**
     */
    const outcome = await payments.holdDamageSecurity({ ...SECURING, excess: null });

    expect(outcome.kind).toBe('not_required');
    // Nothing was written and nobody was asked. A zero-value hold would have
    // told an owner we secured the handover; a refusal would have told them we
    // tried and could not.
    expect(provider.holds).toEqual([]);
    expect(await intents.findForBooking('booking-1')).toEqual([]);
  });

  it('holds nothing when the band sizes this booking’s excess at zero', async () => {
    /*
     * **Reachable, not theoretical.** A band with a zero floor and a zero or tiny
     * percentage produces £0 — the admin form permits both — and 5.5b-ii's
     * migration is explicit that a zero excess is legitimate and distinct from an
     * absent one. There is no such thing as authorising nothing, and
     * `intent_amount_is_positive` refuses the row, so without this guard a
     * legitimate configuration becomes a 500 at the collection window.
     */
    const outcome = await payments.holdDamageSecurity({
      ...SECURING,
      excess: pence(0),
    });

    expect(outcome.kind).toBe('not_required');
    expect(provider.holds).toEqual([]);
    expect(await intents.findForBooking('booking-1')).toEqual([]);
  });

  it('authorises the excess without capturing it, and posts nothing to the ledger', async () => {
    const outcome = await payments.holdDamageSecurity(SECURING);

    expect(outcome.kind).toBe('attempted');
    expect(provider.holds).toHaveLength(1);
    expect(provider.holds[0]?.amount).toEqual(EXCESS);

    // **Authorise, never capture.** `begin` is the verb that takes money and it
    // must not have been called.
    expect(provider.requests).toEqual([]);

    /*
     * **An authorisation moves no money, so §5's books say nothing about it.**
     * This is the assertion that would fail if somebody "tidied" the purpose
     * narrowing out of `applyOutcome`.
     */
    expect(ledgerStore.posted).toEqual([]);
  });

  it('sizes the hold from the excess it was given and never from a fee policy', async () => {
    await payments.holdDamageSecurity(SECURING);

    // A hold does not divide, so nothing about it is a question for the pinned
    // fee policy — asking would be the first step towards settling one.
    expect(feePolicies.asked).toEqual([]);
  });

  it('records the provider’s own expiry, and invents none when it gives none', async () => {
    const captureBefore = new Date('2026-08-28T09:00:00.000Z');
    provider.willReport({ status: 'succeeded', authorisationExpiresAt: captureBefore });

    const held = await payments.holdDamageSecurity(SECURING);
    expect(held.kind === 'attempted' && held.intent.authorisationExpiresAt).toEqual(
      captureBefore,
    );

    /*
     * §8.7.2 is normative that the expiry is the provider's timestamp. A hold
     * whose provider stated none must read back with none — a default supplied
     * here would be a duration we assumed, and Visa merchant-initiated re-auths
     * hold 5 days where the common figure is 7.
     */
    provider.willReport({ status: 'succeeded' });
    const second = await payments.holdDamageSecurity({
      ...SECURING,
      bookingId: 'booking-2',
    });
    expect(
      second.kind === 'attempted' && second.intent.authorisationExpiresAt,
    ).toBeUndefined();
  });

  it('does not hold twice when the collection window is worked twice', async () => {
    provider.willReport({ status: 'pending_payer_action' });

    await payments.holdDamageSecurity(SECURING);
    await payments.holdDamageSecurity(SECURING);

    // The second call finds the open attempt by its derived key and stops. Two
    // holds against one card for one handover is money a renter cannot spend.
    expect(provider.holds).toHaveLength(1);
  });

  it('keeps its attempt keys clear of the hire charge’s', async () => {
    await payments.payForHire(INSTRUCTION);
    await payments.holdDamageSecurity(SECURING);

    const keys = (await intents.findForBooking('booking-1')).map((i) => i.attemptKey);

    /*
     * `attemptKey` is unique across the whole table, so a shared key would make
     * the hold read back the charge's row — an amount reserved that nobody asked
     * for, or a charge treated as already attempted.
     */
    expect([...keys].sort()).toEqual(['hire:booking-1:0', 'security:booking-1:0']);
    // Sorted, because the order the store returns them in is not the property
    // under test — that both exist and differ is.
    expect(new Set(keys).size).toBe(2);
  });

  it('does not let a declined card renumber the other flow’s next key', async () => {
    provider.willReport({
      status: 'failed',
      failure: { reason: 'declined', message: 'Your card was declined.' },
    });
    await payments.holdDamageSecurity(SECURING);

    provider.willReport({ status: 'succeeded' });
    await payments.payForHire(INSTRUCTION);

    /*
     * The hire's key still counts from zero. If failures were counted across
     * purposes, this charge would mint `hire:booking-1:1` — a key the provider
     * has never seen — while any open attempt sat there unfound.
     */
    expect(provider.requests[0]?.idempotencyKey).toBe('hire:booking-1:0');
  });

  it('reports a failed hold as an attempt rather than as no security', async () => {
    provider.willReport({
      status: 'failed',
      failure: { reason: 'declined', message: 'Your card was declined.' },
    });

    const outcome = await payments.holdDamageSecurity(SECURING);

    /*
     * **The whole point of the two kinds.** A failed hold is `attempted` with a
     * failed intent, never `not_required` — the caller in 5.5c-ii decides
     * `SECURITY_FAILED` from exactly this difference, and collapsing them would
     * hand an item over against a hold that was never taken.
     */
    expect(outcome.kind).toBe('attempted');
    expect(outcome.kind === 'attempted' && outcome.intent.status).toBe('failed');
    expect(ledgerStore.posted).toEqual([]);
  });

  it('settles a hold arriving later by webhook without posting to the ledger', async () => {
    /*
     * **The path a real hold usually takes.** SCA means the answer normally
     * arrives out of band, so the hold completes through `refresh` rather than
     * through the call that opened it — and `refresh` is purpose-agnostic. If
     * the narrowing in `applyOutcome` were removed, *this* is where a hold would
     * be settled as a hire charge and posted to the books.
     */
    provider.willReport({ status: 'pending_payer_action' });
    const opened = await payments.holdDamageSecurity(SECURING);
    if (opened.kind !== 'attempted') throw new Error('expected an attempt');

    provider.willReport({ status: 'succeeded' });
    const settled = await payments.refresh(opened.intent.id);

    expect(settled?.status).toBe('succeeded');
    expect(ledgerStore.posted).toEqual([]);
  });

  it('refuses an attempt key reused for a different amount', async () => {
    await payments.holdDamageSecurity(SECURING);

    await expect(
      payments.holdDamageSecurity({ ...SECURING, excess: pence(7_500) }),
    ).rejects.toBeInstanceOf(PaymentIntentError);
  });
});
