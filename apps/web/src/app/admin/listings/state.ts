/**
 * Form state for the moderation decision, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions — see
 * `admin/categories/state.ts` for what happens when one exports an object, and
 * why the failure only appears when the button is pressed. Enforced by the
 * `use-server-exports-only-functions` invariant.
 */

import type { ModerationState } from '@platform/contracts';

export interface ModerationActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  /**
   * What the API recorded, not what was submitted.
   *
   * The page reports this so a decision the platform stored differently is
   * visible rather than assumed. `null` until something has been recorded.
   */
  readonly recorded: ModerationState | null;
  /**
   * Which listing the message is about.
   *
   * A moderator working through several ids from a report needs the confirmation
   * to name the one it belongs to. Without it, a stale message beside a fresh id
   * reads as a decision about the listing now in the box.
   */
  readonly listingId: string;
  /** Kept so a rejected submit does not make somebody retype it. */
  readonly reason: string;
}

export const INITIAL_MODERATION_STATE: ModerationActionState = {
  status: 'idle',
  message: null,
  recorded: null,
  listingId: '',
  reason: '',
};
