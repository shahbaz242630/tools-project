'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  MAX_ADMIN_REASON_LENGTH,
  MIN_ADMIN_REASON_LENGTH,
  MODERATION_STATES,
  moderationRequiresReason,
} from '@platform/contracts';
import type { ModerationState } from '@platform/contracts';
import { moderateListingAction } from '../app/admin/listings/actions';
import { INITIAL_MODERATION_STATE } from '../app/admin/listings/state';
import type { ModerationActionState } from '../app/admin/listings/state';

/**
 * What each state means, in the words a moderator needs when choosing.
 *
 * Derived by mapping over `MODERATION_STATES` rather than hand-listing three
 * options, so a fourth state cannot arrive in the vocabulary and be missing from
 * the only control that sets it — which is how a state becomes unreachable by
 * the one route anybody can use.
 */
const MEANINGS: Record<ModerationState, { label: string; explains: string }> = {
  APPROVED: {
    label: 'Nothing is holding it back',
    explains:
      'The default, and what you choose to put a listing back. It becomes visible ' +
      'again only if its owner had it published — if they paused it, it stays paused.',
  },
  UNDER_REVIEW: {
    label: 'Under review — hide it while somebody looks',
    explains:
      'For a listing you are still deciding about. Out of public view, and the ' +
      'owner is asked to wait rather than to change anything.',
  },
  REJECTED: {
    label: 'Refused — hide it',
    explains:
      'For a listing that has been looked at and is not allowed. Out of public ' +
      'view, and the owner is being told to fix it or take it down.',
  },
};

/**
 * The one control that sets a listing's moderation state (§8.3, §9, ADR 0041).
 *
 * **Three radios rather than three buttons**, which is the opposite of the choice
 * `FeatureFlagSwitch` made and for a reason worth keeping. A flag has two states,
 * so a button per operation is what stops a stale page inverting one. This has
 * three, and each is an absolute destination rather than a toggle — "set it to
 * refused" means the same thing whatever the page last saw, so staleness cannot
 * turn one operation into another.
 *
 * **The reason box states which of the two rules it is under before the button is
 * pressed**, never after. `required` for the states that hide a listing;
 * `minLength` for any state, which is exactly the contract's own rule — a reason
 * is optional when reinstating, and anything actually typed must clear the
 * administrative floor. Native validation and the server action say the same
 * thing because both read the same two constants, and the API is still the
 * authority behind both.
 *
 * **It does not show the listing**, because there is nothing yet to show it with:
 * every read in Catalogue is owner-scoped, so an administrator cannot fetch
 * somebody else's listing at all. The page above says so plainly rather than
 * implying a moderator has seen what they are deciding about.
 */
export function ListingModerationForm() {
  const [state, action, pending] = useActionState(
    moderateListingAction,
    INITIAL_MODERATION_STATE,
  );

  /*
   * Both fields live in React state rather than in `defaultValue`.
   *
   * React 19 resets the form once the action settles, and a reset restores each
   * control from its *attribute* — which for a fresh form is empty. Slice 2.7a
   * found this on the category fee fields and 2.4c-i on checkboxes: type a
   * reason, be refused, and lose what you typed while being told to supply it.
   * `value` + `onChange` is what survives, because the value round-trips through
   * the action state.
   */
  const [listingId, setListingId] = useState('');
  const [reason, setReason] = useState('');
  /**
   * **Nothing is pre-selected, and that is the safety property of this control.**
   *
   * Any default would be one a moderator can submit without having read the
   * options — and two of the three take a stranger's listing out of public view.
   * A pre-selected `UNDER_REVIEW` turns "typed an id, wrote a reason, pressed the
   * button" into a hidden listing; no default turns it into a question.
   *
   * `APPROVED` as the default would be the harmless-looking version of the same
   * mistake: it is the state that *undoes* a colleague's decision.
   */
  const [chosen, setChosen] = useState<ModerationState | null>(null);

  const hiding = chosen !== null && moderationRequiresReason(chosen);

  useEffect(() => {
    if (state.status === 'idle') return;

    /*
     * **The choice is cleared whenever the action settles — succeeded or not —
     * and that is a bug fix, the fifth variant of one this project keeps
     * meeting.**
     *
     * React 19 resets the form once an action settles. A controlled `value`
     * survives that: React re-syncs it, which is why 2.4b, 2.5a and 2.7a were
     * all fixed by moving a field to `value` + `onChange`, and why the id in the
     * box above stays put through a refusal. **A controlled `checked` does
     * not.** The reset unchecked the radio in the DOM, `chosen` had not changed
     * so nothing re-rendered, and the mark never came back — leaving a form with
     * no visible selection while the help text still read *"optional when
     * reinstating"*, because that sentence comes from React state and the mark
     * comes from the DOM. It was visible on the success path and again on the
     * 404, which is what makes it the control's behaviour rather than one path's
     * bug.
     *
     * So `chosen` is cleared to match what the DOM now shows, in both
     * directions. **The asymmetry with the reason and the id is deliberate**:
     * losing typed text to a refusal is the defect 2.7a fixed and is expensive
     * to undo, while re-picking one of three radios is a single click — and
     * re-affirming *what you are about to do to a stranger's listing* after
     * something went wrong is worth a click. `required` makes it deliberate
     * again.
     *
     * The id stays, because a moderator working through several listings from
     * one report needs to see which one they have just decided, and because a
     * refused decision is usually retried against the same id.
     */
    setChosen(null);
    if (state.status === 'done') setReason('');
  }, [state]);

  return (
    <form action={action}>
      <p>
        <label htmlFor="listingId">Listing id</label>
        <input
          id="listingId"
          name="listingId"
          type="text"
          required
          value={listingId}
          onChange={(event) => {
            setListingId(event.target.value);
          }}
          aria-describedby="listingId-help"
        />
      </p>
      <p id="listingId-help">
        The listing&rsquo;s own id, not its owner&rsquo;s. There is no list to pick from
        — see above.
      </p>

      <fieldset>
        <legend>What the platform permits</legend>

        {MODERATION_STATES.map((option) => (
          <p key={option}>
            <label htmlFor={`state-${option}`}>
              <input
                id={`state-${option}`}
                type="radio"
                name="state"
                value={option}
                /*
                 * **`required`, found by pressing the button with nothing
                 * chosen.** The action refuses that — it must, because a form
                 * can be posted by something that never rendered this page —
                 * but the refusal arrived from the server for a fact the
                 * browser already had. That is the H3b rule pointing at its own
                 * author: a control must not let somebody submit into a refusal
                 * it could have shown them.
                 *
                 * Nothing is pre-selected, so this is what makes choosing
                 * deliberate rather than merely uncontradicted.
                 */
                required
                checked={chosen === option}
                onChange={() => {
                  setChosen(option);
                }}
              />{' '}
              {MEANINGS[option].label}
            </label>
            <br />
            <span id={`state-${option}-help`}>{MEANINGS[option].explains}</span>
          </p>
        ))}
      </fieldset>

      <p>
        <label htmlFor="reason">
          {chosen === null
            ? 'Why'
            : hiding
              ? 'Why — required'
              : 'Why — optional when reinstating'}
        </label>
        <textarea
          id="reason"
          name="reason"
          required={hiding}
          minLength={MIN_ADMIN_REASON_LENGTH}
          maxLength={MAX_ADMIN_REASON_LENGTH}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          aria-describedby="reason-help"
        />
      </p>
      <p id="reason-help">
        {chosen === null
          ? `Whether this is required depends on what you choose above: the two states that hide a listing need one of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters, and putting a listing back needs none.`
          : hiding
            ? `At least ${String(MIN_ADMIN_REASON_LENGTH)} characters. This is why somebody’s listing is not visible, it is recorded against you in the audit trail, and it is written to be read by the owner — so write what you would say to them.`
            : `Not needed to put a listing back. If you do give one it is recorded with the decision, and it must be at least ${String(MIN_ADMIN_REASON_LENGTH)} characters like every other reason an administrator gives.`}
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record this decision'}
        </button>
      </p>

      <Feedback state={state} />
    </form>
  );
}

/**
 * The outcome, focused and scrolled to.
 *
 * **The effect depends on the whole state object, not on `state.message`.** Two
 * consecutive identical failures produce the same string, and a dependency on
 * the string compares equal and skips the effect — leaving the page still on the
 * second press, which is exactly when somebody concludes it is stuck. Slice
 * 2.4c-ii found this the hard way.
 */
function Feedback({ state }: { readonly state: ModerationActionState }) {
  const alert = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.message === null) return;
    alert.current?.focus({ preventScroll: true });
    // Optional call: jsdom does not implement `scrollIntoView`, and a component
    // test asserting the message should not fail on a browser affordance.
    alert.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  if (state.message === null) return null;

  return (
    <p role={state.status === 'error' ? 'alert' : 'status'} ref={alert} tabIndex={-1}>
      {/*
       * The listing and the state come *before* the sentence, and both are the
       * API's answer rather than the form's input.
       *
       * Naming the listing matters because the id survives a recorded decision
       * while the choice does not: the field still holds what was just decided,
       * so the confirmation has to say which listing it is about rather than
       * leaving somebody to infer it from the box above. Naming the *state* is
       * what makes a decision the platform stored differently visible, instead
       * of reading back as the one that was asked for.
       */}
      {state.status === 'done' && state.recorded !== null ? (
        <>
          <strong>
            Listing <code>{state.listingId}</code> is now <code>{state.recorded}</code>.
          </strong>{' '}
        </>
      ) : null}
      {state.message}
    </p>
  );
}
