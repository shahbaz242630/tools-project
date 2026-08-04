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
}

export const INITIAL_LISTING_STATE: ListingActionState = {
  status: 'idle',
  message: null,
  categorySlug: '',
  title: '',
  description: '',
  replacementValue: '',
};

/** Re-exported so the form imports its props type from one place. */
export type { CategoryOption };
