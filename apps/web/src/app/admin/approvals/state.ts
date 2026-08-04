/**
 * Form state for the approvals forms, deliberately **not** in `actions.ts`.
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
 * Proposing a role change, and deciding somebody else's proposal.
 *
 * Reasons are validated here *and* by the API, and the API's answer is the one
 * that counts — a check in a form is a convenience, never a control.
 */

export interface ApprovalActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  /** Kept so the form does not clear what was typed on a failure. */
  readonly userId: string;
  readonly reason: string;
}

export const INITIAL_APPROVAL_STATE: ApprovalActionState = {
  status: 'idle',
  message: null,
  userId: '',
  reason: '',
};
