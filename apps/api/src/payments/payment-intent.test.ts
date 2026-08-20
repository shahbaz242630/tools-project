import { Money } from '@platform/core';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_INTENT_PURPOSES,
  PAYMENT_INTENT_STATUSES,
  PaymentIntentError,
  assertSameAttempt,
  dispositionOf,
  hireCaptureKey,
  isTerminal,
} from './payment-intent.js';
import type {
  NewPaymentIntent,
  PaymentIntentRecord,
  PaymentIntentStatus,
} from './payment-intent.js';
import { PAYMENT_ATTEMPT_STATUSES } from './payment-provider.js';

/**
 * The payment intent's vocabulary and its one rule (slice 5.2b).
 *
 * **The rule is what happens when a provider tells us something twice, or tells
 * us two different things.** Both are ordinary — no provider guarantees webhook
 * order or at-most-once delivery — and §11.2's gate is that they produce exactly
 * one ledger effect between them. This is where that is decided; the service
 * merely obeys it.
 */

describe('the payment intent vocabulary', () => {
  it('is the provider port’s statuses plus the one that precedes it', () => {
    // The extra value is not decoration. The row is written *before* the
    // provider is called so a crash between the two leaves a record rather than
    // an untraceable charge, and `initiated` is the state that record is in.
    expect([...PAYMENT_INTENT_STATUSES]).toEqual([
      'initiated',
      ...PAYMENT_ATTEMPT_STATUSES,
    ]);
  });

  it('has one purpose, and does not invent the second in advance', () => {
    // §8.7.2's damage-security hold is the obvious next one and arrives with the
    // flow that writes it — the rule 5.1 set for ledger account kinds.
    expect([...PAYMENT_INTENT_PURPOSES]).toEqual(['hire_charge']);
  });

  it('names no provider anywhere in it', () => {
    // ADR 0051: our verbs, not theirs. `requires_action` is Stripe's word.
    for (const status of [...PAYMENT_INTENT_STATUSES, ...PAYMENT_INTENT_PURPOSES]) {
      expect(status).not.toMatch(/stripe|mangopay|adyen/i);
    }
  });

  it('treats success and failure as final, and nothing else', () => {
    const terminal = PAYMENT_INTENT_STATUSES.filter(isTerminal);
    expect(terminal).toEqual(['succeeded', 'failed']);
  });

  it('keys a capture by booking, not by attempt', () => {
    // The provider's key is per attempt so a decline can be retried; the
    // ledger's is per booking so a hire is captured once however many times
    // somebody tried. Conflating them is how a retry becomes unpayable.
    expect(hireCaptureKey('booking-7')).toBe('hire-capture:booking-7');
    expect(hireCaptureKey('booking-7')).toBe(hireCaptureKey('booking-7'));
  });
});

describe('deciding what an arriving outcome means', () => {
  it('applies news', () => {
    expect(dispositionOf('initiated', 'pending_payer_action')).toEqual({
      kind: 'apply',
    });
    expect(dispositionOf('pending_payer_action', 'succeeded')).toEqual({
      kind: 'apply',
    });
    expect(dispositionOf('processing', 'failed')).toEqual({ kind: 'apply' });
  });

  it('ignores a repeat of what it already knows', () => {
    // The duplicate webhook, which is normal provider behaviour and must not be
    // an error — §11.2 asks for one ledger effect, not for a rejection.
    for (const status of PAYMENT_ATTEMPT_STATUSES) {
      expect(dispositionOf(status, status)).toEqual({
        kind: 'ignore',
        why: `already ${status}`,
      });
    }
  });

  it('refuses to unsettle a settled attempt, whichever way round', () => {
    /*
     * **Out-of-order delivery, which is the case worth reading twice.**
     * Providers do not guarantee order, so `processing` can legitimately arrive
     * after `succeeded`. Applying it would move a finished payment back to
     * unfinished and the next reconciling read would move it forward again — a
     * row that oscillates, and a support conversation nobody can win.
     */
    expect(() => dispositionOf('succeeded', 'processing')).toThrow(PaymentIntentError);
    expect(() => dispositionOf('succeeded', 'failed')).toThrow(/cannot become failed/);
    expect(() => dispositionOf('failed', 'succeeded')).toThrow(
      /a retry is a new attempt/,
    );
  });

  it('lets every non-terminal status move to every other', () => {
    // An exhaustive sweep rather than three examples, so a status added later
    // without thought about its edges fails here.
    const open = PAYMENT_INTENT_STATUSES.filter(
      (status): status is PaymentIntentStatus => !isTerminal(status),
    );

    for (const from of open) {
      for (const to of PAYMENT_ATTEMPT_STATUSES) {
        const disposition = dispositionOf(from, to);
        expect(disposition.kind).toBe(from === to ? 'ignore' : 'apply');
      }
    }
  });
});

describe('refusing a reused attempt key', () => {
  const GBP = 'GBP' as const;
  const pence = (n: number): ReturnType<typeof Money.money> => Money.money(n, GBP);

  const PROPOSED: NewPaymentIntent = {
    bookingId: 'booking-1',
    ownerId: 'user-dale',
    categoryVersionId: 'version-1',
    purpose: 'hire_charge',
    attemptKey: 'attempt-1',
    itemCharge: pence(5_400),
    renterFee: pence(432),
    amount: pence(5_832),
    provider: 'fake',
  };

  const found = (over: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord => ({
    ...PROPOSED,
    id: 'intent-1',
    status: 'initiated',
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...over,
  });

  it('returns the row when it is the same attempt', () => {
    // The double press, which is the whole reason `begin` is get-or-create.
    expect(assertSameAttempt(PROPOSED, found())).toEqual(found());
  });

  it('does not mind what state the attempt has reached', () => {
    // A second press while the first is mid-challenge is still the same attempt.
    expect(
      assertSameAttempt(PROPOSED, found({ status: 'pending_payer_action' })).id,
    ).toBe('intent-1');
  });

  it.each([
    ['a different booking', { bookingId: 'booking-2' }],
    ['a different payee', { ownerId: 'user-sam' }],
    ['a different pinned version', { categoryVersionId: 'version-2' }],
    ['a different total', { amount: pence(9_999) }],
    ['a different item charge', { itemCharge: pence(9_000) }],
    ['a different renter fee', { renterFee: pence(0) }],
  ])('refuses %s', (_why, over) => {
    /*
     * Idempotent in the letter and wrong in substance: the caller believes it
     * opened an attempt for what it passed, and it did not. Every field is swept
     * rather than one, because the one nobody thought to compare is the one that
     * silently pays the wrong person.
     */
    expect(() => assertSameAttempt(PROPOSED, found(over))).toThrow(PaymentIntentError);
  });
});
