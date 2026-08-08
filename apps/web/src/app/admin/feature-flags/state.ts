/**
 * Form state for the flag switch, deliberately **not** in `actions.ts`.
 *
 * A `'use server'` file may only export async functions — see
 * `admin/categories/state.ts` for what happens when one exports an object, and
 * why the failure only appears when the button is pressed. Enforced by the
 * `use-server-exports-only-functions` invariant.
 */

export interface FeatureFlagActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  /**
   * Which flag the message is about.
   *
   * The page renders one form per flag, so without this every form would show
   * every other form's outcome. A switch that reports somebody else's success is
   * worse than one that reports nothing, and this page is operated under
   * pressure.
   */
  readonly key: string | null;
  /** Kept so a rejected submit does not make somebody retype it. */
  readonly reason: string;
}

export const INITIAL_FEATURE_FLAG_STATE: FeatureFlagActionState = {
  status: 'idle',
  message: null,
  key: null,
  reason: '',
};
