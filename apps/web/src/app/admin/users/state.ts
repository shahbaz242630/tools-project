/**
 * Form state for the admin user lookup and suspension forms, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions. Next turns every
 * export of one into a server action, and an exported object makes the route's
 * generated action loader fail with *"A 'use server' file can only export async
 * functions, found object."* — **when the action is invoked, not when the page
 * renders**, so the form looks perfect until somebody presses the button.
 *
 * Enforced by the `use-server-exports-only-functions` invariant.
 */

import type { AdminUserView } from '@platform/contracts';

/**
 * Looking up an account, as an administrator.
 *
 * The reason is validated here *and* by the API, and the API's answer is the
 * one that counts — a check in a form is a convenience, never a control. This
 * one exists so somebody does not wait for a round trip to be told their
 * reason was too short.
 */

export interface AdminUserLookupState {
  readonly status: 'idle' | 'loaded' | 'error';
  readonly view: AdminUserView | null;
  readonly message: string | null;
  /** Kept so the form does not clear what was typed on a failure. */
  readonly userId: string;
  readonly reason: string;
}

/**
 * Suspending an account, or lifting a suspension.
 *
 * Separate from the lookup action even though both live on the same page: one
 * reads and one changes something, and a single action handling both would make
 * the write reachable by a stray form field.
 */
export interface SuspensionActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  readonly reason: string;
}

export const INITIAL_ADMIN_USER_STATE: AdminUserLookupState = {
  status: 'idle',
  view: null,
  message: null,
  userId: '',
  reason: '',
};

export const INITIAL_SUSPENSION_STATE: SuspensionActionState = {
  status: 'idle',
  message: null,
  reason: '',
};
