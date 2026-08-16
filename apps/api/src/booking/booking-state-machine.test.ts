import { describe, expect, it } from 'vitest';
import { BOOKING_STATES, INITIAL_BOOKING_STATE } from '@platform/contracts';
import type { BookingState } from '@platform/contracts';
import {
  CALENDAR_OCCUPYING_STATES,
  InvalidBookingTransitionError,
  TERMINAL_STATES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
  occupiesCalendar,
} from './booking-state-machine.js';

/**
 * §7's state machine (slice 4.1).
 *
 * **This file carries a third of Phase 4's exit gate** — *"all allowed and
 * forbidden transitions are tested"* — and the word doing the work there is
 * *forbidden*. A suite that checks the transitions somebody thought of proves
 * the happy paths; the gate asks for the other 482.
 *
 * **What the 529 generated cases prove, and what they do not.** They assert
 * that `canTransition` agrees with `TRANSITIONS` for every ordered pair, which
 * means no state is special-cased and no branch has been added beside the
 * table. They do **not** prove the table matches the BRD — read literally, that
 * check is a tautology over one data structure, and it stays green if the whole
 * table is wrong in the same way.
 *
 * **Three things do the real work, and they were checked by breaking the code.**
 * The edge count (47) and the forbidden count (482) are derived from §7 by
 * counting its rows, independently of the transcription — and the first version
 * of this file said 51 and 478, which is precisely the transcription error the
 * counts exist to catch. The structural properties — every target exists, every
 * state reachable, terminals go nowhere, every occupying state releases — are
 * facts about the graph that a wrong table fails. And the *prose* cases at the
 * foot of the file pin the half-dozen rules §7 states in sentences rather than
 * in its table, which is where a plausible-looking edit does its damage.
 *
 * **Verified by mutation**: adding `COLLECTED → CANCELLED`, an edge §7 does not
 * have, fails three tests including the prose one about cancellation after
 * handover; removing §7.3's early-return edge fails three including the prose
 * one about it. Neither is caught by the generated pairs, which is the point of
 * saying all this out loud.
 */

/** Every ordered pair, including a state with itself. 23 × 23 = 529. */
const ALL_PAIRS: readonly (readonly [BookingState, BookingState])[] =
  BOOKING_STATES.flatMap((from) => BOOKING_STATES.map((to) => [from, to] as const));

describe('the transition table against BRD §7', () => {
  it('defines every state in §7 and no others', () => {
    // A state in the table that is not in the vocabulary, or the reverse, is
    // how the two drift — and the failure would be a booking stuck in a state
    // nothing can move it out of.
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...BOOKING_STATES].sort());
  });

  /*
   * **§7: "a transition target that has no row in this table is a specification
   * defect."** Ours is the same rule turned on our own transcription — a typo
   * in a target would otherwise be a state nothing could ever reach, and the
   * suite below would happily assert it is unreachable.
   */
  it('names only states that exist, everywhere it names one', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const target of targets) {
        expect(BOOKING_STATES, `${from} → ${target}`).toContain(target);
      }
    }
  });

  /*
   * The inverse, and the one that catches a state quietly going missing from a
   * *source* row rather than a target one. `DRAFT` is excluded because nothing
   * transitions into where every booking begins.
   */
  it('leaves no state unreachable but the one bookings start in', () => {
    const reachable = new Set(Object.values(TRANSITIONS).flat());
    const orphans = BOOKING_STATES.filter(
      (state) => state !== INITIAL_BOOKING_STATE && !reachable.has(state),
    );

    expect(orphans).toEqual([]);
  });

  it('never lets a state transition to itself', () => {
    // Not a §7 rule but a consequence of every row in it, and worth asserting:
    // a self-transition is how an idempotent retry silently becomes a second
    // booking event with nothing having changed.
    for (const state of BOOKING_STATES) {
      expect(TRANSITIONS[state], state).not.toContain(state);
    }
  });
});

describe('which transitions are allowed', () => {
  /*
   * **The gate clause, generated rather than written.** Each of the 529 ordered
   * pairs is allowed exactly when §7's table says so — so a transition added to
   * the table without the BRD, or removed from it by accident, fails here.
   */
  it.each(ALL_PAIRS)('%s → %s is allowed only if §7 says so', (from, to) => {
    expect(canTransition(from, to)).toBe(TRANSITIONS[from].includes(to));
  });

  it('permits every move §7 lists, and there are 47 of them', () => {
    // The count is asserted so that a whole row lost to a bad merge is visible
    // as a number rather than as a quietly smaller table. Forty-seven, counted
    // from §7 rather than guessed — the first version of this test said 51 and
    // was simply wrong, which is the argument for asserting it at all.
    const edges = Object.values(TRANSITIONS).flat().length;

    expect(edges).toBe(47);
  });

  it('refuses every move §7 does not list', () => {
    const forbidden = ALL_PAIRS.filter(([from, to]) => !TRANSITIONS[from].includes(to));

    // 529 ordered pairs minus 47 edges. Stated so that a table which grew
    // permissive is caught here as well as in the generated cases above.
    expect(forbidden).toHaveLength(482);
    for (const [from, to] of forbidden) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
    }
  });
});

describe('terminal states', () => {
  /*
   * §7 marks exactly two rows `None (terminal)`. Asserted as a *set* rather
   * than a count, because a state that lost its outgoing edges by accident
   * would otherwise pass a count check by replacing one that gained some.
   */
  it('are ABANDONED and CLOSED, which are §7’s two', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['ABANDONED', 'CLOSED']);
  });

  it('refuse every move, including to themselves', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of BOOKING_STATES) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      }
      expect(isTerminal(from)).toBe(true);
    }
  });

  it('are the only states with nowhere to go', () => {
    for (const state of BOOKING_STATES) {
      expect(isTerminal(state), state).toBe(TERMINAL_STATES.includes(state));
    }
  });

  /*
   * **Every non-terminal path ends somewhere.** A state whose only exits lead
   * back into a cycle with no way out would be a booking nothing can ever
   * finish — the kind of defect that shows up months later as a dashboard row
   * nobody can clear. Checked by walking forward from every state.
   */
  it('are reachable from every other state', () => {
    for (const start of BOOKING_STATES) {
      const seen = new Set<BookingState>([start]);
      const queue: BookingState[] = [start];
      let reachesTerminal = false;

      while (queue.length > 0) {
        const state = queue.shift() as BookingState;
        if (isTerminal(state)) {
          reachesTerminal = true;
          break;
        }
        for (const next of TRANSITIONS[state]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      expect(reachesTerminal, `${start} can never finish`).toBe(true);
    }
  });
});

describe('which states occupy a calendar (§8.5.1)', () => {
  /*
   * **The set slice 4.2's `EXCLUDE` constraint is scoped to**, transcribed from
   * §8.5.1 and checked here rather than trusted. It is the only list in this
   * file that is not derived, because it is a rule about something other than
   * the shape of the graph.
   */
  it('is exactly §8.5.1’s nine', () => {
    expect([...CALENDAR_OCCUPYING_STATES].sort()).toEqual([
      'ACCEPTED',
      'AWAITING_PAYMENT',
      'COLLECTED',
      'LATE',
      'PAYMENT_FAILED',
      'READY_FOR_COLLECTION',
      'RESERVED',
      'RETURN_DUE',
      'SECURITY_FAILED',
    ]);
  });

  /*
   * **§7.1's central design decision, as a test.** Several renters may hold a
   * request against the same listing and dates; none of them reserves anything.
   * A `REQUESTED` booking that blocked the calendar would let the first person
   * to click decide who gets the item instead of the owner, and would let
   * anybody freeze a listing for nothing.
   */
  it('does not include REQUESTED, which is what makes §7.1 work', () => {
    expect(occupiesCalendar('REQUESTED')).toBe(false);
  });

  it('includes no terminal state, because a finished booking holds nothing', () => {
    for (const state of TERMINAL_STATES) {
      expect(occupiesCalendar(state), state).toBe(false);
    }
  });

  /*
   * **Every state that holds a calendar must be able to stop holding it**, or a
   * listing is blocked forever by a booking nothing can move — the failure that
   * costs an owner money silently.
   *
   * **Reachability, not a single step, and the difference is a finding.** The
   * first version of this asked for a one-step exit and `ACCEPTED` failed it:
   * §7 gives it exactly two targets, `AWAITING_PAYMENT` and `RESERVED`, and
   * *both occupy the calendar*. The dates are still released eventually —
   * `AWAITING_PAYMENT` can expire, `RESERVED` can be cancelled — so the
   * specification is not broken, and a one-step rule was simply the wrong rule.
   *
   * **What it did surface is worth carrying into slice 4.6.** `ACCEPTED` has no
   * `EXPIRED` and no `CANCELLED` edge, unlike every other early state. That is
   * safe only while `ACCEPTED` is momentary — acceptance moves straight on to
   * `AWAITING_PAYMENT` or `RESERVED` in the same transaction — and it stops
   * being safe the moment anything can leave a booking sitting there. Recorded
   * in the phase handoff as an input to 4.6 rather than left to be discovered.
   */
  it('lets every occupying state release the calendar eventually', () => {
    for (const start of CALENDAR_OCCUPYING_STATES) {
      const seen = new Set<BookingState>([start]);
      const queue: BookingState[] = [start];
      let released = false;

      while (queue.length > 0) {
        const state = queue.shift() as BookingState;
        if (!occupiesCalendar(state)) {
          released = true;
          break;
        }
        for (const next of TRANSITIONS[state]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      expect(released, `${start} can never release the calendar`).toBe(true);
    }
  });

  /*
   * The narrower fact the test above used to assert, kept as its own case
   * because it is the one that will change: `ACCEPTED` is the single occupying
   * state with no immediate way out of the calendar. If a later slice gives it
   * one — an acceptance that can expire before payment begins — this is where
   * that shows up, and it should be updated deliberately rather than deleted.
   */
  it('leaves ACCEPTED as the only occupying state with no one-step release', () => {
    const withoutImmediateExit = CALENDAR_OCCUPYING_STATES.filter(
      (state) => !TRANSITIONS[state].some((next) => !occupiesCalendar(next)),
    );

    expect(withoutImmediateExit).toEqual(['ACCEPTED']);
  });
});

describe('taking a transition', () => {
  it('returns the new state when §7 permits it', () => {
    expect(assertTransition('REQUESTED', 'ACCEPTED')).toBe('ACCEPTED');
  });

  it('throws when it does not, naming both states', () => {
    expect(() => assertTransition('REQUESTED', 'COLLECTED')).toThrow(
      InvalidBookingTransitionError,
    );
    // Diagnosable from a log line, which matters most for the transitions
    // nothing on screen triggers — the expiry worker and §7.1's auto-decline.
    expect(() => assertTransition('REQUESTED', 'COLLECTED')).toThrow(
      /from REQUESTED to COLLECTED/,
    );
  });

  it('refuses to move a terminal booking', () => {
    expect(() => assertTransition('CLOSED', 'REQUESTED')).toThrow(
      InvalidBookingTransitionError,
    );
  });
});

/**
 * Rules §7 states in prose rather than in its table, pinned here because the
 * table alone does not say them and each is a plausible wrong move.
 */
describe('what §7 says outside the table', () => {
  /*
   * **§7.2: an extension is not a state.** *"An extension does not introduce a
   * new booking state… The booking remains `COLLECTED` or `RETURN_DUE`
   * throughout."* Adding an `EXTENDED` state is the obvious wrong move — it
   * looks tidier and it would put a booking outside the calendar-occupying set
   * for the duration of the extension, which is precisely when it is holding
   * the item.
   */
  it('has no state for an extension', () => {
    const extensionish = BOOKING_STATES.filter((state) => /EXTEN/.test(state));

    expect(extensionish).toEqual([]);
  });

  /*
   * **§7.3: early return.** *"`COLLECTED` may transition directly to
   * `RETURNED_PENDING_CONFIRMATION` where the renter returns before the period
   * ends."* It is in the table, and it is here as well because it reads like a
   * mistake — the intuitive path is `COLLECTED → RETURN_DUE → RETURNED…` and
   * somebody tidying the graph would remove the shortcut.
   */
  it('lets a renter return early without waiting for the period to end', () => {
    expect(canTransition('COLLECTED', 'RETURNED_PENDING_CONFIRMATION')).toBe(true);
  });

  /*
   * **A collected booking cannot be cancelled**, which §7 expresses only by
   * omission. Once an item has changed hands the answer is a return or a
   * dispute; a cancellation would leave the platform with no state describing
   * where the item physically is. Asserted because "surely anything can be
   * cancelled" is exactly the assumption somebody would add an edge on.
   */
  it('offers no cancellation once the item has changed hands', () => {
    for (const state of ['COLLECTED', 'RETURN_DUE', 'LATE'] as const) {
      expect(canTransition(state, 'CANCELLED'), state).toBe(false);
    }
  });

  /*
   * **Payment failure is recoverable and expiry is not.** §7 lets
   * `PAYMENT_FAILED` go back to `AWAITING_PAYMENT` — a declined card is a retry,
   * not the end of a booking — while `EXPIRED` leads only to `CLOSED`, because a
   * deadline that has passed cannot be un-passed.
   */
  it('lets a failed payment be retried but not an expired deadline', () => {
    expect(canTransition('PAYMENT_FAILED', 'AWAITING_PAYMENT')).toBe(true);
    expect(TRANSITIONS.EXPIRED).toEqual(['CLOSED']);
  });

  /*
   * **§8.7's rule that a failed hold is never a silent unsecured handover.**
   * `SECURITY_FAILED` may retry the authorisation or end the booking; what it
   * may not do is proceed to `COLLECTED`.
   */
  it('never lets a failed damage hold reach collection directly', () => {
    expect(canTransition('SECURITY_FAILED', 'COLLECTED')).toBe(false);
    expect(canTransition('SECURITY_FAILED', 'READY_FOR_COLLECTION')).toBe(true);
  });

  /*
   * **A dispute can be opened from every state where something has gone wrong,
   * and from none where nothing has yet.** Worth pinning because the natural
   * instinct is "disputes can happen any time": before `RESERVED` there is no
   * money and no item, so there is nothing to dispute.
   */
  it('opens disputes only after there is something to dispute', () => {
    const disputable = BOOKING_STATES.filter((state) =>
      canTransition(state, 'DISPUTED'),
    );

    expect([...disputable].sort()).toEqual([
      'COLLECTED',
      'LATE',
      'NO_SHOW',
      'RESERVED',
      'RETURNED_PENDING_CONFIRMATION',
      'SECURITY_FAILED',
    ]);
  });
});
