import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BOOKING_STATES } from '@platform/contracts';
import { BookingStateLabel, bookingStateWording } from './booking-state';

/**
 * What a booking's state means to the person reading it (slice 4.8b).
 *
 * **The file is about two things a page cannot be allowed to get wrong**: that
 * every one of §7's states renders as words rather than a database constant, and
 * that the four reachable ones say something true to *each* party — the same
 * state means different things to the person waiting and the person who has been
 * asked.
 */

describe('every state in §7', () => {
  it('has a label for both parties, and none of it is a raw constant', () => {
    /*
     * §7 has 23 states and the product can reach four. The other nineteen still
     * have to render *something*: a page that printed `RETURNED_PENDING_
     * CONFIRMATION` at a person would be the vocabulary leaking through the
     * layer that exists to translate it.
     */
    for (const state of BOOKING_STATES) {
      for (const party of ['renter', 'owner'] as const) {
        const { label } = bookingStateWording(state, party);

        expect(label).not.toBe('');
        expect(label).not.toBe(state);
        expect(label).not.toMatch(/_/);
        expect(label).not.toMatch(/^[A-Z]+$/);
      }
    }
  });

  it('explains only the states the product can actually reach', () => {
    /*
     * **The guard against invented copy**, and the reason it is shaped as a
     * whitelist rather than a word filter. The first version of this test banned
     * the word "paid" everywhere and failed on *"Nothing has been paid yet"* —
     * which is precisely the sentence that keeps §7's `RESERVED` (*payment
     * secured*) from being implied a phase early. Banning a word cannot tell an
     * assertion from its negation.
     *
     * What is actually forbidden is copy for a flow nobody has built. Nineteen
     * of §7's states are unreachable until Phase 5, 7 or 8; each explains itself
     * the day something can put a booking into it, and not before.
     */
    const explained = BOOKING_STATES.filter(
      (state) =>
        bookingStateWording(state, 'renter').meaning !== null ||
        bookingStateWording(state, 'owner').meaning !== null,
    );

    expect([...explained].sort()).toEqual([
      'ACCEPTED',
      'DECLINED',
      'EXPIRED',
      'REQUESTED',
    ]);
  });
});

describe('a request nobody has answered', () => {
  it('tells the renter it is the owner who has not answered', () => {
    const { label, meaning } = bookingStateWording('REQUESTED', 'renter');

    expect(label).toBe('Waiting for an answer');
    expect(meaning).toContain('The owner has not answered');
  });

  it('tells the owner it is waiting on them', () => {
    // The whole reason this function takes a party. One label would have to pick
    // an audience and be wrong for half of every page.
    const { label, meaning } = bookingStateWording('REQUESTED', 'owner');

    expect(label).toBe('Waiting for your answer');
    expect(meaning).toContain('accept or decline');
  });
});

describe('an accepted booking', () => {
  it('says the dates are held and that nothing has been paid', () => {
    const { label, meaning } = bookingStateWording('ACCEPTED', 'renter');

    expect(label).toBe('Confirmed');
    expect(meaning).toContain('held for you');
    expect(meaning).toContain('Nothing has been paid');
  });

  it('warns the owner it cannot be cancelled yet', () => {
    /*
     * §7 gives `ACCEPTED` no cancel edge until `RESERVED`, which is Phase 5, so
     * accepting is a one-way door. 4.6b says so on the control; this says so
     * afterwards, where an owner goes looking for the undo.
     */
    const { meaning } = bookingStateWording('ACCEPTED', 'owner');

    expect(meaning).toContain('cannot be cancelled yet');
  });
});

describe('a request that lapsed', () => {
  it('tells the renter nothing was charged and no dates were held', () => {
    const { label, meaning } = bookingStateWording('EXPIRED', 'renter');

    expect(label).toBe('Expired');
    expect(meaning).toContain('lapsed on its own');
  });
});

describe('a declined request', () => {
  it('does not guess why, because the projection cannot tell', () => {
    /*
     * §7.1 requires an auto-declined renter to be told a conflict took the
     * dates, and the difference between that and an owner's decline lives in an
     * event's *type* — which this projection deliberately does not carry. So the
     * list says what happened and the detail read says why. A list that guessed
     * would be wrong half the time.
     */
    const { meaning } = bookingStateWording('DECLINED', 'renter');

    expect(meaning).not.toMatch(/somebody else|another renter|conflict/i);
  });
});

describe('the states no phase has built', () => {
  it('renders ordinary words rather than the constant', () => {
    expect(bookingStateWording('RETURN_DUE', 'renter').label).toBe('Return due');
    expect(bookingStateWording('PARTIALLY_REFUNDED', 'owner').label).toBe(
      'Partially refunded',
    );
  });

  it('explains nothing, rather than inventing copy for a flow nobody built', () => {
    expect(bookingStateWording('COLLECTED', 'renter').meaning).toBe(null);
    expect(bookingStateWording('RESERVED', 'owner').meaning).toBe(null);
  });
});

describe('the label component', () => {
  it('renders the words, so colour is never the only signal', () => {
    // WCAG 1.4.1. `VisibilityLabel` keeps its text when it goes green and this
    // follows it.
    render(<BookingStateLabel state="ACCEPTED" party="renter" />);

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });
});
