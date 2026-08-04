/**
 * Form state for the admin activity lookup, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions. Next turns every
 * export of one into a server action, and an exported object makes the route's
 * generated action loader fail with *"A 'use server' file can only export async
 * functions, found object."* — **when the action is invoked, not when the page
 * renders**, so the form looks perfect until somebody presses the button.
 *
 * Enforced by the `use-server-exports-only-functions` invariant.
 */

import type { ActivityEntry } from '@platform/contracts';

/**
 * Looking up an account's activity, as an administrator.
 *
 * The reason is validated here *and* by the API, and the API's answer is the
 * one that counts — a check in a form is a convenience, never a control. This
 * one exists so somebody does not wait for a round trip to be told their
 * reason was too short.
 */

export interface AdminLookupState {
  readonly status: 'idle' | 'loaded' | 'error';
  readonly entries: readonly ActivityEntry[];
  readonly message: string | null;
  /** Kept so the form does not clear what was typed on a failure. */
  readonly userId: string;
  readonly reason: string;
}

export const INITIAL_ADMIN_LOOKUP_STATE: AdminLookupState = {
  status: 'idle',
  entries: [],
  message: null,
  userId: '',
  reason: '',
};
