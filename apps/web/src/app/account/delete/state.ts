/**
 * Form state for the account deletion form, deliberately **not** in `actions.ts`.
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
 * Deleting an account, in the order that survives a failure.
 *
 * **Our data first, the credential second** (ADR 0018). The API erases the
 * personal data and tombstones the account; only then does the credential go at
 * Clerk. The reverse would mean a failure between the two leaves somebody
 * locked out of an account that still holds their address, with no way to ask
 * again.
 *
 * The credential deletion happens here rather than in the API because the web
 * app is the only service holding a key that can do it (ADR 0015). That is also
 * why this is a server action: `CLERK_SECRET_KEY` must never reach a browser.
 */

export interface DeletionFormState {
  readonly status: 'idle' | 'deleted' | 'error';
  readonly message: string | null;
  /**
   * True when the account is gone from our side but the credential may remain.
   * Worth telling somebody, because they may still appear signed in.
   */
  readonly credentialRemains: boolean;
}

export const INITIAL_DELETION_FORM_STATE: DeletionFormState = {
  status: 'idle',
  message: null,
  credentialRemains: false,
};
