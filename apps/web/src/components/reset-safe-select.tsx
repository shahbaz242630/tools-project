'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * A `<select>` whose value survives the form reset React performs after a
 * server action settles.
 *
 * **Why this exists.** React 19 resets the form once an action settles. A reset
 * restores every control from its *attributes* — and a `<select>` with no
 * `<option selected>` has nothing to restore to, so the browser falls back to
 * the first option. React then re-renders, sees that the `value` prop has not
 * changed, and writes nothing back. The result is a select displaying and
 * reporting `""` while React's own state still holds the real answer.
 *
 * That is the same defect slice 2.4c-i found on a checkbox, and its note said
 * *"controlled `value` inputs are unaffected; React re-applies those"*. **That
 * is true of `<input>` and false of `<select>`**, which is what slice 2.5a
 * discovered by pressing Save with half an address filled in: the category
 * select read "Choose a category" while the category's own fields were still on
 * screen and the hidden version number still said 2. The form would have posted
 * an empty category slug beside a version number for the category it no longer
 * named — and the obvious human response, re-picking the category, fires the
 * change handler that wipes every category answer already given.
 *
 * **Why a ref rather than `defaultValue`.** `defaultValue` is the fix for a
 * checkbox because `defaultChecked` is what a reset restores. It does not work
 * here: after mount, changing `defaultValue` updates the attribute but not the
 * live value, and the transport field's value genuinely moves on its own as the
 * weight is typed (slice 2.4c-ii). So the select stays controlled, and this
 * re-asserts the value React already believes after anything external has moved
 * the DOM underneath it.
 *
 * One component rather than the same effect in three files, because there are
 * three selects on this form and the fourth one somebody adds will not remember.
 */
export function ResetSafeSelect({
  id,
  name,
  value,
  onChange,
  required,
  describedBy,
  children,
}: {
  readonly id: string;
  /**
   * Optional: a category's own `choice` field carries no name, because the
   * whole set of answers is posted as one hidden JSON value rather than as
   * indexed field names (ADR 0027's editor makes the same choice).
   */
  readonly name?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly describedBy?: string;
  readonly children: ReactNode;
}) {
  const select = useRef<HTMLSelectElement>(null);

  /**
   * The current value, readable from an event handler that outlives this render.
   *
   * The listener below is registered once per form, so it would otherwise close
   * over the value as it stood when it was attached — and restore a stale answer
   * on every reset after the first.
   */
  const latest = useRef(value);
  latest.current = value;

  /**
   * Restore the value **after** the reset, listening for the event that does the
   * damage.
   *
   * An effect running on every render does not work here, and the reason is
   * worth stating: `form.reset()` changes the DOM without changing any React
   * state, so it triggers no render and no effect. The `reset` event is the only
   * thing that reliably fires, and it fires *before* the controls are restored —
   * hence the microtask, which lands immediately after.
   *
   * Deliberately not `preventDefault()` on the event. The reset is how every
   * `defaultValue` field on the form picks up the values the action sent back;
   * cancelling it would fix this select by breaking the title, the description
   * and the whole collection address.
   */
  useEffect(() => {
    const form = select.current?.form;
    if (form === undefined || form === null) return;

    const restore = () => {
      queueMicrotask(() => {
        const node = select.current;
        if (node !== null && node.value !== latest.current) node.value = latest.current;
      });
    };

    form.addEventListener('reset', restore);
    return () => {
      form.removeEventListener('reset', restore);
    };
  }, []);

  return (
    <select
      id={id}
      {...(name === undefined ? {} : { name })}
      ref={select}
      value={value}
      {...(required === true ? { required: true } : {})}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {children}
    </select>
  );
}
