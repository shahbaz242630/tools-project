import { describe, expect, it } from 'vitest';
import {
  BOOKING_DECLINE_REASONS,
  BOOKING_STATES,
  BOOKING_STATE_LABELS,
  INITIAL_BOOKING_STATE,
  bookingDeclineReasonSchema,
  bookingStateSchema,
} from './booking.js';

describe('the booking state vocabulary', () => {
  /*
   * **Twenty-three, not twenty-two — and the BRD says both.** §7's table has 23
   * rows; the quick-reference index at the top of the BRD calls it a *"Booking
   * state machine (22 states)"*, and every handoff in this project has repeated
   * "22-state booking machine" from that summary rather than from the table.
   * Counted row by row on 16 August 2026: the table wins, because it is the
   * normative artefact and the summary is a pointer to it.
   *
   * The count is asserted at all because §7's table is long enough that a state
   * lost in an edit is invisible by eye, and each one is a case the dashboards,
   * the expiry worker and Phase 5's ledger handle forever.
   */
  it('is BRD §7’s twenty-three states', () => {
    expect(BOOKING_STATES).toHaveLength(23);
  });

  it('starts a booking in DRAFT, before anything is committed', () => {
    expect(INITIAL_BOOKING_STATE).toBe('DRAFT');
    expect(BOOKING_STATES).toContain(INITIAL_BOOKING_STATE);
  });

  it('has no duplicates, which a hand-transcribed list is how you get', () => {
    expect(new Set(BOOKING_STATES).size).toBe(BOOKING_STATES.length);
  });

  it('accepts every state it declares and refuses anything else', () => {
    for (const state of BOOKING_STATES) {
      expect(bookingStateSchema.parse(state)).toBe(state);
    }
    expect(() => bookingStateSchema.parse('EXTENDED')).toThrow();
    expect(() => bookingStateSchema.parse('accepted')).toThrow();
  });
});

describe('why a booking was declined', () => {
  /*
   * **§7.1 requires the two to be told apart.** An owner saying no and the
   * platform auto-declining the loser of a race both produce `DECLINED`, and the
   * renter is told which — one is a decision about them and the other is not.
   */
  it('separates an owner’s decline from §7.1’s auto-decline', () => {
    expect([...BOOKING_DECLINE_REASONS].sort()).toEqual([
      'AUTO_DECLINED_CONFLICT',
      'OWNER_DECLINED',
    ]);
  });

  it('is a closed vocabulary, so nothing a person typed can reach a renter', () => {
    expect(() => bookingDeclineReasonSchema.parse('too far away')).toThrow();
  });

  /*
   * **`AUTO_DECLINED_CONFLICT` is §7.1's own term, spelled its way.** It is the
   * one value here that appears verbatim in the specification, and a rename
   * would quietly break the correspondence a later reader relies on.
   */
  it('uses §7.1’s exact name for the conflict case', () => {
    expect(BOOKING_DECLINE_REASONS).toContain('AUTO_DECLINED_CONFLICT');
  });
});

describe('what a state is called on screen', () => {
  it('labels every state, so no dashboard can render a raw constant', () => {
    for (const state of BOOKING_STATES) {
      expect(BOOKING_STATE_LABELS[state], state).toBeTruthy();
    }
    expect(Object.keys(BOOKING_STATE_LABELS).sort()).toEqual(
      [...BOOKING_STATES].sort(),
    );
  });

  /*
   * **Never the constant itself.** `RETURNED_PENDING_CONFIRMATION` is a database
   * value; showing it to a person is slice 3.1d's defect in a different field —
   * the state was right and the words were wrong, and no test caught it because
   * nothing was broken.
   */
  it('never shows a database value to a person', () => {
    for (const [state, label] of Object.entries(BOOKING_STATE_LABELS)) {
      expect(label, state).not.toMatch(/_/);
      expect(label, state).not.toBe(state);
    }
  });

  it('reads as a sentence rather than shouting', () => {
    for (const [state, label] of Object.entries(BOOKING_STATE_LABELS)) {
      expect(label, state).not.toBe(label.toUpperCase());
    }
  });
});
