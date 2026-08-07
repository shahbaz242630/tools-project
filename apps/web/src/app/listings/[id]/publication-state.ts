import type { PublicationBlocker } from '@platform/contracts';

/**
 * The publish button's state, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions, and an exported object
 * makes the route's generated action loader fail with *"A 'use server' file can
 * only export async functions, found object"* — **when the action is invoked,
 * not when the page renders**. Slice 2.4a found that in six files at once, and
 * the `use-server-exports-only-functions` invariant now refuses it.
 */
export interface PublicationActionState {
  readonly status: 'idle' | 'error' | 'not-ready';
  readonly message: string | null;
  /**
   * What is still missing, when that is why it was refused.
   *
   * Empty for every other outcome, and `status` rather than the length is what
   * distinguishes them — a failed request with no blockers and a listing with
   * nothing missing would otherwise look identical.
   */
  readonly blockers: readonly PublicationBlocker[];
}

export const INITIAL_PUBLICATION_STATE: PublicationActionState = {
  status: 'idle',
  message: null,
  blockers: [],
};
