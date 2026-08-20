import { PaymentIntentError } from './payment-intent.js';
import type { PaymentAttempt, PaymentProvider } from './payment-provider.js';

/**
 * The absence of a payment provider, made explicit (slice 5.2c).
 *
 * **This is not a fake and it is not a stub.** A fake stands in for a real thing
 * during a test; this stands in a running production process for a thing that
 * **does not exist yet** — 5.2e builds the Stripe adapter and needs an account
 * nobody has opened. Every method throws.
 *
 * **It is unreachable, and what keeps it unreachable is a feature flag rather
 * than luck.** `booking.payment` defaults off and `BookingsService` refuses
 * before it touches the booking's state, so nothing in the product can reach
 * these methods. If the flag were switched on with this still wired, throwing is
 * exactly right: the loud failure is a 500 with a sentence naming the cause, not
 * a booking quietly moved to `PAYMENT_FAILED` as though somebody's card had been
 * declined.
 *
 * **The alternative was a provider that always fails, and it was rejected.**
 * `status: 'failed'` is a claim about a card. Making it on a platform that never
 * contacted a bank would put a lie in `payment_intents`, in the booking's event
 * history and in whatever a renter was shown — and `PAYMENT_FAILED` is a state
 * nobody can leave by fixing anything on their end.
 *
 * **Delete this file in 5.2e.** It exists to make the gap visible at the
 * composition root, and a placeholder that outlives its gap becomes furniture.
 */
export class NoPaymentProvider implements PaymentProvider {
  /**
   * **`none`, not `stripe`.**
   *
   * The name is stored on every `payment_intents` row and is what makes a row
   * readable after a provider change (ADR 0051). Naming a provider we have not
   * integrated would make those rows claim something untrue, and this class
   * cannot write one anyway.
   */
  readonly name = 'none';

  begin(): Promise<PaymentAttempt> {
    return Promise.reject(refusal());
  }

  read(): Promise<PaymentAttempt> {
    return Promise.reject(refusal());
  }
}

function refusal(): PaymentIntentError {
  return new PaymentIntentError(
    'no payment provider is configured: the Stripe adapter is slice 5.2e and the ' +
      'booking.payment feature flag is what should be keeping this unreachable',
  );
}
