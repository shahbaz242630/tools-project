/**
 * Form state for the category forms, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions. Next turns every
 * export of one into a server action, and an exported object makes the route's
 * generated action loader fail with *"A 'use server' file can only export async
 * functions, found object."* — **when the action is invoked, not when the page
 * renders**, so the form looks perfect until somebody presses the button.
 *
 * Enforced by the `use-server-exports-only-functions` invariant.
 */

import type { CategoryReportableActivity } from '@platform/contracts';

/**
 * Creating a category, and changing one.
 *
 * Validated here *and* by the API, and the API's answer is the one that counts —
 * a check in a form is a convenience, never a control. The reason the checks
 * exist at all is that a round trip to be told "slug: must be lowercase" is a
 * worse experience than being told before sending it.
 */

export interface CategoryActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  /** Kept so a failure does not clear what was typed. */
  readonly slug: string;
  readonly name: string;
  readonly reason: string;
  /**
   * Kept for the opposite reason to the others.
   *
   * The rest are here so a rejected submit does not make somebody retype. This
   * one is here so a rejected submit does not silently *reset* — a form that
   * bounced back showing `none` when the administrator chose
   * `means_of_transport` would be telling them the safe thing about a decision
   * they did not make.
   */
  readonly reportableActivity: CategoryReportableActivity;
}

export const INITIAL_CATEGORY_STATE: CategoryActionState = {
  status: 'idle',
  message: null,
  slug: '',
  name: '',
  reason: '',
  reportableActivity: 'none',
};
