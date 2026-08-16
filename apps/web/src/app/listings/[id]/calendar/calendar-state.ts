/**
 * What the calendar's two controls report back.
 *
 * **A `'use server'` file may export only async functions** (slice 2.4a), which
 * is why this sits beside `actions.ts` rather than in it.
 *
 * **One shape for both controls, and unlike the publication pair they are not
 * mutually exclusive** — a page can hold several periods, each with a remove
 * button, and the add form is on screen at the same time. Each control still
 * owns its *own* state; what is shared is the type, so a page rendering an
 * outcome does not need two ways of reading one.
 */

/** What was typed, so that a refusal does not empty the form. */
export interface SubmittedPeriod {
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
}

export interface CalendarActionState {
  readonly status: 'idle' | 'error';
  /** Empty while idle. Rendered verbatim — it is written for the reader. */
  readonly message: string;
  /**
   * The values that were submitted, echoed back for `defaultValue`.
   *
   * **React 19 resets an uncontrolled form once its action completes**, which is
   * right for a form that succeeded and is how 2.4c-i, 2.5a and 2.7a each lost
   * somebody's typing. Carrying the values through the state is what
   * `CreateCategoryForm` does, and it was found here the same way all three of
   * those were: by pressing the button and watching two dates disappear behind
   * an explanation of why they were refused.
   *
   * Empty on the remove control, which has nothing typed into it.
   */
  readonly submitted: SubmittedPeriod;
}

const NOTHING_TYPED: SubmittedPeriod = { startDate: '', endDate: '', reason: '' };

export const INITIAL_CALENDAR_STATE: CalendarActionState = {
  status: 'idle',
  message: '',
  submitted: NOTHING_TYPED,
};

/**
 * An outcome carrying a sentence, and whatever was typed.
 *
 * `submitted` defaults to nothing, which is what the remove control wants — and
 * what the add form must never take, because a default that quietly empties the
 * fields is the defect this parameter exists to prevent.
 */
export function calendarError(
  message: string,
  submitted: SubmittedPeriod = NOTHING_TYPED,
): CalendarActionState {
  return { status: 'error', message, submitted };
}
