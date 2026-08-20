import { describe, expect, it } from 'vitest';
import { NoPaymentProvider } from './no-payment-provider.js';
import { PaymentIntentError } from './payment-intent.js';

/**
 * The absence of a provider (slice 5.2c).
 *
 * **A small file guarding a decision somebody will be tempted to undo.** The
 * tempting change is to make these methods return `{ status: 'failed' }` instead
 * of throwing, because a failure reads as tidier than an exception — and it would
 * be a lie: `failed` is a claim about a card, made by a platform that has never
 * contacted a bank, and it would move a booking to `PAYMENT_FAILED`, a state a
 * renter cannot leave by fixing anything on their end.
 *
 * These tests fail if that happens.
 */

const provider = new NoPaymentProvider();

describe('the absence of a payment provider', () => {
  it('names no provider it has not integrated', async () => {
    // Stored on every `payment_intents` row (ADR 0051). Saying `stripe` here
    // would make rows claim something untrue about who moved the money.
    expect(provider.name).toBe('none');
  });

  it('refuses to begin a payment, loudly', async () => {
    await expect(provider.begin()).rejects.toBeInstanceOf(PaymentIntentError);
  });

  it('refuses to read one', async () => {
    await expect(provider.read()).rejects.toBeInstanceOf(PaymentIntentError);
  });

  it('says what is missing and what is meant to be stopping this', async () => {
    // Somebody meets this in a log line. "Payment failed" would tell them
    // nothing; naming the slice and the flag tells them exactly what to do.
    await expect(provider.begin()).rejects.toThrow(/5\.2e/);
    await expect(provider.begin()).rejects.toThrow(/booking\.payment/);
  });

  it('never reports a card outcome', async () => {
    /*
     * **The regression this file exists for.** Returning `failed` would put a
     * claim about somebody's card into `payment_intents`, into the booking's
     * event history and into whatever the renter was shown.
     */
    await expect(
      (async () => {
        const attempt = await provider.begin();
        return attempt.status;
      })(),
    ).rejects.toThrow();
  });
});
