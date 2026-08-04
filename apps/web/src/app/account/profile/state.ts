/**
 * Form state for the profile form, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions. Next turns every
 * export of one into a server action, and an exported object makes the route's
 * generated action loader fail with *"A 'use server' file can only export async
 * functions, found object."* — **when the action is invoked, not when the page
 * renders**, so the form looks perfect until somebody presses the button.
 *
 * Enforced by the `use-server-exports-only-functions` invariant.
 */

/**
 * Saving the profile, from the form to the API.
 *
 * A server action rather than a browser `fetch`, for the reason the whole
 * topology exists: the API is not reachable from the internet. Only the web app
 * is on the edge network, so the request has to be made server-side — and the
 * session token never has to be handed to client JavaScript to do it.
 */

export interface ProfileFormState {
  readonly status: 'idle' | 'saved' | 'invalid' | 'error';
  /** Field-level problems, shown against the form. */
  readonly issues: readonly string[];
  /** A single sentence for the states that are nobody's fault. */
  readonly message: string | null;
}

export const INITIAL_PROFILE_FORM_STATE: ProfileFormState = {
  status: 'idle',
  issues: [],
  message: null,
};
