/**
 * What the photograph controls report back, deliberately **not** in
 * `media-actions.ts`.
 *
 * A `'use server'` file may only export async functions, and an exported object
 * makes the route's generated action loader fail with *"A 'use server' file can
 * only export async functions, found object"* — **when the action is invoked,
 * not when the page renders**. Slice 2.4a found that in six files at once, and
 * the `use-server-exports-only-functions` invariant now refuses it.
 */

export interface MediaActionState {
  /**
   * `idle` covers both "nothing has happened" and "it worked".
   *
   * **One state rather than a separate `done`**, because the gallery *is* the
   * confirmation: a deleted photograph disappears and a reordered one moves. A
   * success message beside a picture that visibly changed is noise, and it would
   * still be on screen the next time somebody looked at the page.
   */
  readonly status: 'idle' | 'error';
  readonly message: string | null;
}

export const INITIAL_MEDIA_STATE: MediaActionState = {
  status: 'idle',
  message: null,
};
