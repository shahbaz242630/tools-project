import type { CategoryOption } from '@platform/contracts';

/**
 * The listing form's state, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions. Next turns every
 * export of one into a server action, and an exported object makes the route's
 * generated action loader fail with *"A 'use server' file can only export async
 * functions, found object."*
 *
 * **The failure only appears when the action is invoked**, not when the page
 * renders — the loader is built for the action request. So a form with a
 * constant exported beside its action looks completely fine until the first
 * person presses the button, which is exactly how this was found: by pressing
 * it.
 */
export interface ListingActionState {
  readonly status: 'idle' | 'error';
  readonly message: string | null;
  /** Kept so a failure does not clear what was typed. */
  readonly categorySlug: string;
  readonly title: string;
  readonly description: string;
  readonly replacementValue: string;
  /**
   * The collection address, kept as typed so a refusal does not empty it.
   *
   * Four separate strings rather than one object, because that is what the form
   * holds — these are echoed straight back into `defaultValue` on four inputs,
   * and an object here would be assembled and taken apart again for nothing.
   *
   * **Kept even when the failure is about something else.** Retyping an address
   * because a title was two characters short is the kind of small insult that
   * makes people abandon a form.
   */
  readonly line1: string;
  readonly line2: string;
  readonly town: string;
  readonly postcode: string;
  /**
   * The category-specific answers are **not** here, and that is not an
   * oversight. They live in the form component's own state, which survives an
   * action round trip because the component is re-rendered rather than
   * remounted — echoing them through here as well would be a second copy that
   * can disagree with the inputs the person is looking at.
   */
}

export const INITIAL_LISTING_STATE: ListingActionState = {
  status: 'idle',
  message: null,
  categorySlug: '',
  title: '',
  description: '',
  replacementValue: '',
  line1: '',
  line2: '',
  town: '',
  postcode: '',
};

/** Re-exported so the form imports its props type from one place. */
export type { CategoryOption };
