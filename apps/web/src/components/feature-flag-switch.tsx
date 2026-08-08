'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { AdminFeatureFlag } from '@platform/contracts';
import { Time } from '@platform/core';
import { setFeatureFlagAction } from '../app/admin/feature-flags/actions';
import { INITIAL_FEATURE_FLAG_STATE } from '../app/admin/feature-flags/state';
import type { FeatureFlagActionState } from '../app/admin/feature-flags/state';

/**
 * One flag, and the switch that throws it.
 *
 * **Two buttons rather than a toggle**, and that is the decision worth keeping.
 * A toggle means "invert whatever this was when the page rendered", so an
 * administrator acting on a page that is thirty seconds stale can turn something
 * back *on* while trying to turn it off. Each button states the operation it
 * performs, so a stale page produces a no-op rather than the opposite of what
 * somebody intended — which is the failure mode that matters on the one control
 * that changes the platform for everybody at once.
 *
 * Only the button for the state it is *not* in is shown, so there is one action
 * to take and it is unambiguous under pressure.
 */
export function FeatureFlagSwitch({ flag }: { readonly flag: AdminFeatureFlag }) {
  const [state, action, pending] = useActionState(
    setFeatureFlagAction,
    INITIAL_FEATURE_FLAG_STATE,
  );

  /*
   * The reason lives in React state rather than in `defaultValue`.
   *
   * React 19 resets the form once the action settles, and a reset restores each
   * control from its *attribute* — which for a fresh form is empty. Slice 2.7a
   * found this on the category fee fields: type a reason, be refused, and lose
   * what you typed while being told to supply it. `value` + `onChange` is what
   * survives, because the value round-trips through the action state.
   */
  const [reason, setReason] = useState('');

  // Only this flag's outcome. The page renders one of these per flag, and a
  // switch reporting somebody else's result is worse than one reporting nothing.
  const mine = state.key === flag.key ? state : INITIAL_FEATURE_FLAG_STATE;

  useEffect(() => {
    if (mine.status === 'done') setReason('');
  }, [mine]);

  return (
    <form action={action}>
      <input type="hidden" name="key" value={flag.key} />

      <p>
        <strong>{flag.label}</strong>{' '}
        {flag.enabled ? <span>— on</span> : <span>— OFF</span>}
      </p>

      <p>{flag.gates}</p>

      <p>
        {flag.source === 'default'
          ? `At its default (${flag.defaultEnabled ? 'on' : 'off'}). Nobody has changed it.`
          : `Set by an administrator${
              flag.changedAt === null ? '' : ` on ${formatWhen(flag.changedAt)}`
            }. Its default is ${flag.defaultEnabled ? 'on' : 'off'}.`}
      </p>

      <label htmlFor={`reason-${flag.key}`}>Why</label>
      <input
        id={`reason-${flag.key}`}
        name="reason"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />

      {/*
       * The value travels on the button, not on a checkbox. `formAction` is not
       * used because both submits go to the same action — what differs is the
       * operand, and a submit button's `value` is posted only for the button
       * that was pressed.
       */}
      <button
        type="submit"
        name="enabled"
        value={flag.enabled ? 'false' : 'true'}
        disabled={pending}
      >
        {pending
          ? 'Working…'
          : flag.enabled
            ? `Switch off ${flag.label.toLowerCase()}`
            : `Switch on ${flag.label.toLowerCase()}`}
      </button>

      <Feedback state={mine} />
    </form>
  );
}

/**
 * The outcome, focused and scrolled to.
 *
 * **The effect depends on the whole state object, not on `state.message`.** Two
 * consecutive identical failures produce the same string, and a dependency on
 * the string compares equal and skips the effect — leaving the page still on
 * the second press, which is exactly when somebody concludes it is stuck. Slice
 * 2.4c-ii found this the hard way.
 */
function Feedback({ state }: { readonly state: FeatureFlagActionState }) {
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
      {state.message}
    </p>
  );
}

/**
 * A timestamp somebody can read at a glance.
 *
 * `Time.formatLocal` renders in the platform timezone rather than the browser's,
 * and that is right twice over here. An incident review wants one clock, not
 * whichever the reader happens to be in — and this is a client component, so a
 * browser-locale rendering would differ between the server's HTML and the
 * client's and produce a hydration mismatch.
 */
function formatWhen(iso: string): string {
  return Time.formatLocal(Time.fromIsoUtc(iso));
}
