import { describe, expect, it } from 'vitest';
import { BOOKING_STATES } from '@platform/contracts';
import type { BookingState } from '@platform/contracts';
import {
  ONLY_THE_RENTER_PAYS,
  PAYABLE_STATES,
  PAYMENT_NOT_ENABLED,
  SUSPENDED_CANNOT_PAY,
  describeUnpayable,
  payabilityOf,
} from './payability.js';

/**
 * Whether a renter may pay, and what they are told when they may not (5.2d).
 *
 * **Swept rather than sampled.** `payabilityOf` is pure and its input space is
 * small enough to enumerate completely — every §7 state × both parties ×
 * suspended or not × the switch either way — so these tests assert over the whole
 * matrix instead of picking the cases somebody thought of. That is the shape 4.1
 * used for the state machine's 482 forbidden pairs and 5.2a used for settlement.
 */

const RENTER = {
  isRenter: true,
  isSuspended: false,
  paymentEnabled: true,
} as const;

describe('payabilityOf', () => {
  it('lets an ordinary renter pay from each of the three payable states', () => {
    for (const state of PAYABLE_STATES) {
      expect(payabilityOf({ ...RENTER, state })).toEqual({ payable: true });
    }
  });

  /**
   * **The sweep that would catch a state added to §7 without a decision.** A new
   * state is unpayable unless somebody puts it in `PAYABLE_STATES`, which is the
   * safe default — and it must still come with a sentence rather than a blank.
   */
  it('refuses every other state with a reason', () => {
    const unpayable = BOOKING_STATES.filter(
      (state: BookingState) => !PAYABLE_STATES.includes(state),
    );

    expect(unpayable.length).toBeGreaterThan(0);

    for (const state of unpayable) {
      const answer = payabilityOf({ ...RENTER, state });

      expect(answer.payable).toBe(false);
      expect(answer.payable === false && answer.reason.length).toBeGreaterThan(0);
    }
  });

  /**
   * **An owner is not refused, they are simply not the payer** — and the party
   * check runs first, so this holds even for a booking that is otherwise perfectly
   * payable. The route still answers them 404 (5.2c); this is only what their own
   * page says where the renter sees a button.
   */
  it('tells the owner the renter pays, whatever the state', () => {
    for (const state of BOOKING_STATES) {
      expect(payabilityOf({ ...RENTER, isRenter: false, state })).toEqual({
        payable: false,
        reason: ONLY_THE_RENTER_PAYS,
      });
    }
  });

  it('refuses a suspended renter, and says what suspension does (ADR 0024)', () => {
    for (const state of PAYABLE_STATES) {
      expect(payabilityOf({ ...RENTER, state, isSuspended: true })).toEqual({
        payable: false,
        reason: SUSPENDED_CANNOT_PAY,
      });
    }
  });

  it('refuses when payment is switched off, which is production today', () => {
    for (const state of PAYABLE_STATES) {
      expect(payabilityOf({ ...RENTER, state, paymentEnabled: false })).toEqual({
        payable: false,
        reason: PAYMENT_NOT_ENABLED,
      });
    }
  });

  /**
   * **The ordering assertions, and they are the point of the test file.** Each
   * pins one reason beating another, so a refactor that reorders the checks fails
   * here rather than in front of a renter.
   */
  describe('which reason wins', () => {
    it('prefers "already paid for" over "payments are off"', () => {
      /*
       * A renter looking at a settled booking with the switch off must not be told
       * payments are unavailable — they would reasonably conclude their money had
       * gone somewhere it had not.
       */
      expect(
        payabilityOf({ ...RENTER, state: 'RESERVED', paymentEnabled: false }),
      ).toEqual({ payable: false, reason: describeUnpayable('RESERVED') });
    });

    it('prefers the state over suspension', () => {
      expect(payabilityOf({ ...RENTER, state: 'DECLINED', isSuspended: true })).toEqual(
        { payable: false, reason: describeUnpayable('DECLINED') },
      );
    });

    it('prefers suspension over the switch', () => {
      expect(
        payabilityOf({
          ...RENTER,
          state: 'ACCEPTED',
          isSuspended: true,
          paymentEnabled: false,
        }),
      ).toEqual({ payable: false, reason: SUSPENDED_CANNOT_PAY });
    });

    it('prefers "not your booking to pay" over everything', () => {
      expect(
        payabilityOf({
          state: 'ACCEPTED',
          isRenter: false,
          isSuspended: true,
          paymentEnabled: false,
        }),
      ).toEqual({ payable: false, reason: ONLY_THE_RENTER_PAYS });
    });
  });
});

describe('describeUnpayable', () => {
  it('distinguishes the four situations a renter can be in', () => {
    expect(describeUnpayable('RESERVED')).toContain('already paid for');
    expect(describeUnpayable('REQUESTED')).toContain('not been accepted yet');
    expect(describeUnpayable('DECLINED')).toContain('no longer live');
    expect(describeUnpayable('EXPIRED')).toContain('no longer live');
    expect(describeUnpayable('CANCELLED')).toContain('no longer live');
  });

  /**
   * **Every state gets a sentence, including ones nobody has thought about.** The
   * fallback exists so a §7 addition cannot produce an empty explanation, which
   * would render as a control with no reason beside it.
   */
  it('never returns an empty sentence for any state in §7', () => {
    for (const state of BOOKING_STATES) {
      expect(describeUnpayable(state).length).toBeGreaterThan(0);
    }
  });

  /**
   * **No sentence names a flag, an environment, a slice or a state code.** These
   * are read by the public: `PAYMENT_NOT_ENABLED` in particular is what a renter
   * sees today, and leaking `booking.payment` would put an operational concept in
   * front of somebody trying to hire a hedge trimmer.
   */
  it('keeps our vocabulary out of what a renter reads', () => {
    const shown = [
      PAYMENT_NOT_ENABLED,
      ONLY_THE_RENTER_PAYS,
      SUSPENDED_CANNOT_PAY,
      ...BOOKING_STATES.map(describeUnpayable),
    ];

    for (const sentence of shown) {
      expect(sentence).not.toContain('booking.payment');
      expect(sentence).not.toContain('flag');
      expect(sentence).not.toMatch(/\b5\.2[a-e]\b/);
      expect(sentence).not.toMatch(/\b[A-Z_]{4,}\b/);
    }
  });
});
