import { describe, expect, it } from 'vitest';
import { PAYMENT_ATTEMPT_STATUSES } from './payment-provider.js';
import type {
  PaymentAttempt,
  PaymentAttemptStatus,
  PaymentProvider,
} from './payment-provider.js';

/**
 * The payment port's vocabulary (slice 5.2a).
 *
 * **A small file guarding a decision that is easy to undo.** The port has no
 * behaviour to test — it is an interface — but the closed unions on it are the
 * thing ADR 0051 actually buys, and a later slice widening one to `string` to
 * make an adapter compile would pass every other test in the project. The queue
 * metrics learned this the hard way: `QueueJobSample`'s two labels were `string`
 * from H1 until H6.
 */

describe('the payment vocabulary', () => {
  it('has four statuses and no more', () => {
    expect([...PAYMENT_ATTEMPT_STATUSES]).toEqual([
      'pending_payer_action',
      'processing',
      'succeeded',
      'failed',
    ]);
  });

  it('names no provider anywhere in it', () => {
    // ADR 0051: the port speaks our verbs. A status called `requires_action` or
    // `requires_confirmation` would be Stripe's word for it, and the day a second
    // provider arrives somebody has to decide what it means for them.
    for (const status of PAYMENT_ATTEMPT_STATUSES) {
      expect(status).not.toMatch(/stripe|mangopay|adyen|intent/i);
    }
  });

  it('distinguishes "the payer must act" from "we are waiting"', () => {
    // The distinction SCA forces and the one a naive port collapses. Both leave
    // a booking in AWAITING_PAYMENT, but only one has something to hand back to
    // the browser — so a single `pending` would lose the token or invent one.
    expect(PAYMENT_ATTEMPT_STATUSES).toContain('pending_payer_action');
    expect(PAYMENT_ATTEMPT_STATUSES).toContain('processing');
  });

  it('is satisfied by an implementation that returns each status', async () => {
    // A compile-time check with a runtime body: if the port ever grows a method
    // or a required field, this stops type-checking, which is the point.
    const scripted = (status: PaymentAttemptStatus): PaymentAttempt => ({
      providerReference: `ref-${status}`,
      status,
      ...(status === 'pending_payer_action'
        ? { payerAction: { kind: 'confirm_in_browser' as const, token: 'tok' } }
        : {}),
      ...(status === 'failed'
        ? {
            failure: {
              reason: 'declined' as const,
              message: 'Your card was declined.',
            },
          }
        : {}),
    });

    const provider: PaymentProvider = {
      name: 'test',
      begin: (request) =>
        Promise.resolve(scripted(request.amount.amount > 0 ? 'succeeded' : 'failed')),
      read: (reference) =>
        Promise.resolve({ providerReference: reference, status: 'processing' }),
    };

    const begun = await provider.begin({
      idempotencyKey: 'k',
      amount: { amount: 1_944, currency: 'GBP' },
      description: 'Petrol hedge trimmer',
    });
    expect(begun.status).toBe('succeeded');

    const read = await provider.read('ref-1');
    expect(read.status).toBe('processing');
  });

  it('carries a payer-facing failure message with no provider detail in it', () => {
    const failed = {
      providerReference: 'ref',
      status: 'failed' as const,
      failure: {
        reason: 'declined' as const,
        message: 'Your card was declined. Try another card.',
      },
    } satisfies PaymentAttempt;

    // §8.4.1's habit applied to money: what reaches a page says what happened and
    // nothing about who processed it or what the card was.
    expect(failed.failure.message).not.toMatch(/stripe|pi_|card_|\d{4}/i);
  });
});
