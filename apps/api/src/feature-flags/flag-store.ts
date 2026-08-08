import type { FeatureFlagKey } from '@platform/contracts';

/**
 * Feature-flag overrides, as the rest of the application sees them.
 *
 * **The store holds overrides, not flags** (ADR 0036). The vocabulary is
 * declared in `@platform/contracts`; this is only the record of which of those
 * have been switched away from their declared default, by whom and when.
 *
 * There is no `delete`, and the absence is deliberate rather than an oversight:
 * "put it back to the default" is `set(key, defaultEnabled)`, which leaves a row
 * saying somebody decided that — and an audit entry beside it. A delete would
 * erase the fact that a human made the call, leaving a flag indistinguishable
 * from one nobody had ever touched. That distinction is the first thing anybody
 * asks during an incident.
 */

/** One override, as stored. */
export interface FeatureFlagOverrideRecord {
  /**
   * The row's synthetic uuid.
   *
   * Present only because `audit_logs.targetId` is a uuid column, so an audited
   * entity must have one. Nothing else reads it — the *key* is what identifies a
   * flag everywhere else in this module.
   */
  readonly id: string;
  readonly key: string;
  readonly enabled: boolean;
  readonly changedById: string;
  readonly changedAt: Date;
}

export interface FeatureFlagStore {
  /**
   * Every override currently held.
   *
   * Unbounded by design, and this is the one read in the system that may be
   * (ADR 0035): the collection cannot exceed the number of keys the *code*
   * declares, because the evaluator ignores any row whose key it does not know.
   * It is bounded by the build rather than by a `take`, which is a stronger
   * guarantee than a limit — and there is nowhere for it to grow to.
   */
  listOverrides(): Promise<readonly FeatureFlagOverrideRecord[]>;

  /**
   * Switch a flag, creating the override or replacing it.
   *
   * An upsert rather than a create-or-update decided by the caller: two
   * administrators switching the same flag at the same moment must both end with
   * a row, and whichever lands second is the state — which is what "rapid
   * disablement" (§9) needs. There is no conflict to report, because a flag is
   * not a document being edited.
   */
  set(
    key: FeatureFlagKey,
    enabled: boolean,
    changedById: string,
  ): Promise<FeatureFlagOverrideRecord>;
}
