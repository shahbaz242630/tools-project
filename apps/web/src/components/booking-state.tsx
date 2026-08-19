/**
 * What a booking's state means to the person reading it (BRD §7, slice 4.8b).
 *
 * **This file is where the booking vocabulary lives**, exactly as
 * `listing-visibility.tsx` is where the listing one does — and for the reason
 * that file records: a second rendering of the same state written somewhere else
 * is how two places come to disagree about what a row means. Both lists render
 * through this, so a state added to §7 is a compile error in one place.
 *
 * **It is party-aware, and that is the substance rather than a nicety.** One
 * state genuinely means two different things depending on who is looking:
 * `REQUESTED` is *waiting for them* to a renter and *waiting for you* to an
 * owner. A single label would have to pick one audience and be wrong for the
 * other half of every page.
 *
 * **Only four states are reachable today**, and the rest are grouped rather than
 * given invented copy. Writing a sentence for `COLLECTED` would be writing
 * product copy for a flow nobody has built, and several would be false — §7's
 * `RESERVED` means *payment secured*, which is a claim this platform cannot make
 * until Phase 5. They are still cased individually so the compiler refuses a new
 * state, and the grouped branch says plainly that it is provisional.
 *
 * **No `use client`.** No state, no effects, no handlers.
 */

import type { BookingState } from '@platform/contracts';
import styles from './booking-state.module.css';

/** Whose side of the booking is being rendered. */
export type BookingParty = 'renter' | 'owner';

/**
 * How a state reads, and how strongly it should be drawn.
 *
 * **`tone` never carries meaning on its own** (WCAG 1.4.1) — the label always
 * says the thing, and the colour only emphasises it. That is the rule
 * `VisibilityLabel` follows and the reason it keeps its words when it goes green.
 */
export interface BookingStateWording {
  readonly label: string;
  /** One sentence a person can act on, or null when the label says it all. */
  readonly meaning: string | null;
  readonly tone: 'confirmed' | 'waiting' | 'closed' | 'neutral';
}

export function bookingStateWording(
  state: BookingState,
  party: BookingParty,
): BookingStateWording {
  switch (state) {
    case 'REQUESTED':
      return party === 'renter'
        ? {
            label: 'Waiting for an answer',
            meaning:
              'The owner has not answered yet. If they do not, the request expires on ' +
              'its own and the dates are released.',
            tone: 'waiting',
          }
        : {
            label: 'Waiting for your answer',
            meaning:
              'Somebody has asked to hire this. Open the item to accept or decline.',
            tone: 'waiting',
          };

    case 'ACCEPTED':
      /*
       * **"Confirmed", and no promise about money.** §7 puts `RESERVED`
       * — *payment secured* — after this one, and Phase 5 is what makes it
       * true. So the owner is told the dates are held and nothing here says
       * anybody has paid, because nobody has.
       */
      return party === 'renter'
        ? {
            label: 'Confirmed',
            meaning:
              'The owner accepted and these dates are held for you. Nothing has been ' +
              'paid yet — payments arrive later.',
            tone: 'confirmed',
          }
        : {
            label: 'Confirmed',
            meaning:
              'You accepted this and the dates are held. It cannot be cancelled yet — ' +
              'that arrives with payments.',
            tone: 'confirmed',
          };

    case 'DECLINED':
      /*
       * **The same word for both an owner's decline and §7.1's auto-decline**,
       * because this projection cannot tell them apart: `bookingSummarySchema`
       * carries no events, and the difference lives in an event's *type*. A
       * renter who lost the dates to somebody else is owed the distinction
       * (§7.1 requires it) and gets it from the booking's own history, which is
       * the detail read — not from a list that would have to guess.
       */
      return {
        label: 'Declined',
        meaning:
          party === 'renter'
            ? 'This one is not going ahead. The dates were not confirmed for you.'
            : 'You did not take this one, or accepting another request released it.',
        tone: 'closed',
      };

    case 'EXPIRED':
      return party === 'renter'
        ? {
            label: 'Expired',
            meaning:
              'Nobody answered in time, so this lapsed on its own. Nothing was ' +
              'charged and the dates were never held.',
            tone: 'closed',
          }
        : {
            label: 'Expired',
            meaning: 'This went unanswered past its deadline and lapsed on its own.',
            tone: 'closed',
          };

    /*
     * **Everything below is unreachable today and is grouped on purpose.**
     *
     * Nothing in the product can put a booking into any of these: §7's states
     * after `ACCEPTED` need payments (Phase 5), the handover protocol (Phase 7)
     * or disputes (Phase 8), and none of those exist. Inventing a sentence for
     * each would be writing copy for flows nobody has built, and some of it would
     * be false — `RESERVED` means *payment secured*.
     *
     * They are cased individually rather than defaulted so that a **new** state
     * in §7 is a compile error here. When a phase makes one of these reachable,
     * it lifts that case out and writes the real wording — and this branch is
     * where it will be looking.
     */
    case 'DRAFT':
    case 'ABANDONED':
    case 'AWAITING_PAYMENT':
    case 'PAYMENT_FAILED':
    case 'RESERVED':
    case 'READY_FOR_COLLECTION':
    case 'SECURITY_FAILED':
    case 'NO_SHOW':
    case 'COLLECTED':
    case 'RETURN_DUE':
    case 'LATE':
    case 'RETURNED_PENDING_CONFIRMATION':
    case 'COMPLETED':
    case 'REVIEW_WINDOW':
    case 'DISPUTED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'CANCELLED':
    case 'CLOSED':
      return { label: humanise(state), meaning: null, tone: 'neutral' };

    default: {
      // Exhaustiveness, checked by the compiler rather than by review.
      const unhandled: never = state;
      return { label: String(unhandled), meaning: null, tone: 'neutral' };
    }
  }
}

/**
 * `RETURN_DUE` — "Return due".
 *
 * **Only ever reached by the grouped branch above**, so this is a fallback for
 * states no page can currently show. It exists so that the day one becomes
 * reachable before anybody writes its copy, a person reads three ordinary words
 * rather than a database constant.
 */
function humanise(state: string): string {
  const words = state.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The state, drawn. */
export function BookingStateLabel({
  state,
  party,
}: {
  readonly state: BookingState;
  readonly party: BookingParty;
}) {
  const { label, tone } = bookingStateWording(state, party);

  return <span className={styles[tone]}>{label}</span>;
}
