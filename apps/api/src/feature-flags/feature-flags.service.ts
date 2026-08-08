import {
  FEATURE_FLAGS,
  featureFlagDeclaration,
  isFeatureFlagKey,
} from '@platform/contracts';
import type { AdminFeatureFlag, FeatureFlagKey } from '@platform/contracts';
import { Time } from '@platform/core';
import type { Logger } from '@platform/observability';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type { FeatureFlagOverrideRecord, FeatureFlagStore } from './flag-store.js';

/**
 * How long a flag value may be stale, in milliseconds.
 *
 * **The number is a trade between two real costs and neither is theoretical.**
 * Without a cache, every read of a flag is a database round trip on whatever
 * path it gates — and flags gate hot paths by definition, which is the problem
 * slice H2 had just finished solving elsewhere. With too long a cache, §9's
 * "rapid disablement" stops being rapid: an administrator hits the switch during
 * an incident and watches nothing happen.
 *
 * Ten seconds is short enough that a kill switch is effectively immediate to a
 * human, and long enough that a burst of traffic costs one query rather than
 * thousands.
 *
 * **It is a per-process bound, and with more than one API process the real
 * worst case is still ten seconds** — the caches are independent but each
 * expires on its own clock, so no process lags further than this behind the row.
 */
export const FLAG_CACHE_TTL_MS = 10_000;

/**
 * Feature flags: what the code asks, and what an administrator sets.
 *
 * Two audiences with two different needs, which is why there are two reads:
 *
 * - **`isEnabled`** is what a code path calls. It is cached, it never throws,
 *   and it falls back to the declared default.
 * - **`list`** is what the admin page calls. It reads **through** the cache,
 *   because an administrator who has just switched something and is looking at
 *   the result must see the truth rather than a value up to ten seconds old.
 *   A page that shows the old value after a successful write is indistinguishable
 *   from a write that failed.
 */
export class FeatureFlagsService {
  /** Overrides by key, and when this snapshot was taken. Null until first read. */
  private cache: {
    readonly at: number;
    readonly overrides: Map<string, boolean>;
  } | null = null;

  constructor(
    private readonly store: FeatureFlagStore,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    /**
     * Injected so a test can move time without waiting ten seconds, and so the
     * cache's expiry is provable rather than assumed. Defaults to the real
     * clock, which is what production uses.
     *
     * Through `Time.nowUtc()` rather than `Date.now()`, because raw `Date` is
     * banned project-wide (BRD §6.1) and the ban is worth honouring even where
     * what is measured is an *interval* on the local process rather than an
     * instant anybody stores or renders — an exception here would be one more
     * place somebody has to decide whether the rule applies.
     */
    private readonly now: () => number = () => Time.nowUtc().getTime(),
  ) {}

  /**
   * Whether a flag is on, for a code path deciding what to do.
   *
   * **This never throws and never rejects**, and that is its whole contract. A
   * flag read that can fail is one every call site has to wrap, and the first
   * one to forget turns a database blip into a 500 on a path that was working
   * perfectly before anybody added a flag to it. When the store cannot answer,
   * the declared default stands and the failure is logged.
   *
   * The failure is logged at `error` rather than `warn`: the platform is running
   * on defaults and nobody switching a flag can affect it, which is a state
   * somebody needs to know about even though nothing looks broken.
   */
  async isEnabled(key: FeatureFlagKey): Promise<boolean> {
    const declaration = featureFlagDeclaration(key);
    // Unreachable through the type, and guarded rather than asserted because the
    // alternative is reading `undefined.defaultEnabled` on a path that must not
    // throw. A key the build does not declare is off: it gates nothing here, so
    // nothing can be harmed by saying no.
    if (declaration === undefined) return false;

    try {
      const overrides = await this.overrides();
      return overrides.get(key) ?? declaration.defaultEnabled;
    } catch (error) {
      this.logger.error('feature flag read failed, using declared default', {
        key,
        defaultEnabled: declaration.defaultEnabled,
        error: error instanceof Error ? error.message : String(error),
      });
      return declaration.defaultEnabled;
    }
  }

  /**
   * Every flag this build declares, with its effective value.
   *
   * Driven by the **declaration** and not by the rows, so a flag that has never
   * been switched still appears — the admin page has to offer every switch that
   * exists, not only the ones somebody has already used. It is also what makes a
   * stale row harmless: a key the code no longer declares is simply not listed,
   * rather than showing a switch that gates nothing.
   *
   * Unlike `isEnabled`, a failure here **propagates**. A code path needs an
   * answer it can act on; an administrator needs the truth or an error, and a
   * page that quietly showed defaults during a database outage would invite
   * somebody to conclude a flag had been switched back on by itself.
   */
  async list(): Promise<readonly AdminFeatureFlag[]> {
    const rows = await this.readThrough();
    const byKey = new Map(rows.map((row) => [row.key, row]));

    return FEATURE_FLAGS.map((declaration) => {
      const override = byKey.get(declaration.key);

      return {
        key: declaration.key,
        label: declaration.label,
        gates: declaration.gates,
        enabled: override?.enabled ?? declaration.defaultEnabled,
        defaultEnabled: declaration.defaultEnabled,
        source: override === undefined ? 'default' : 'override',
        changedAt: override === undefined ? null : Time.toIsoUtc(override.changedAt),
        changedById: override?.changedById ?? null,
      };
    });
  }

  /**
   * Switch a flag, with a reason, audited.
   *
   * The audit write is awaited and its failure propagates — the module's
   * inherited fail-closed rule (ADR 0017). It matters more here than in most
   * places: this is the one control that changes what the platform *does* for
   * everybody at once, and §9 requires an administrator's actions to record
   * actor, reason, target and before/after state.
   *
   * **The before-state is read first**, so the trail says what it was rather
   * than only what it became. An entry recording "set to off" cannot tell an
   * incident reviewer whether that was a change or a no-op.
   *
   * Resolves to null for a key this build does not declare, so the route can
   * answer 404 without this service knowing what HTTP is. Rejecting an unknown
   * key rather than storing it is the whole point of a closed vocabulary: a
   * stored key nothing reads is a switch that gates nothing.
   */
  async set(
    actor: Actor,
    key: string,
    enabled: boolean,
    reason: string,
  ): Promise<AdminFeatureFlag | null> {
    if (!isFeatureFlagKey(key)) return null;

    const before = (await this.list()).find((flag) => flag.key === key);
    // Unreachable — `isFeatureFlagKey` passed, and `list` is built from the same
    // declarations. Guarded so the digest below cannot be taken of `undefined`.
    if (before === undefined) return null;

    const row = await this.store.set(key, enabled, actor.userId);

    // Dropped rather than expired, so the next read is the truth. Expiring by
    // timestamp would leave the writer's own subsequent read racing its own
    // write, which is the failure mode that makes a switch look broken.
    this.cache = null;

    const after = (await this.list()).find((flag) => flag.key === key);
    if (after === undefined) return null;

    await this.audit.record({
      actor,
      action: 'feature_flag.changed',
      targetType: 'feature_flag',
      // The row's uuid, because `audit_logs.targetId` is a uuid column. The
      // *key* is what a reader actually wants, and it travels in the digested
      // before/after state below — the same position `category.created` is in,
      // which records a category's uuid rather than its slug.
      targetId: row.id,
      before: auditable(before),
      after: auditable(after),
      reason,
    });

    // Logged as well as audited, and this is the one place that duplication is
    // right. The audit trail is the accountable record and is read afterwards;
    // the log is what somebody is watching *during* the incident, and a kill
    // switch nobody can see being thrown is a control with a delay built into
    // reading it.
    this.logger.warn('feature flag changed', {
      key,
      from: before.enabled,
      to: after.enabled,
      changedById: actor.userId,
    });

    return after;
  }

  /** The override map, from cache when it is fresh enough. */
  private async overrides(): Promise<Map<string, boolean>> {
    const cached = this.cache;
    if (cached !== null && this.now() - cached.at < FLAG_CACHE_TTL_MS) {
      return cached.overrides;
    }

    const rows = await this.readThrough();
    const overrides = new Map(rows.map((row) => [row.key, row.enabled]));
    this.cache = { at: this.now(), overrides };
    return overrides;
  }

  /**
   * The rows, ignoring any key this build does not declare.
   *
   * A row left behind by a flag that has since been removed from the code must
   * not appear anywhere: it would show as a switch on the admin page that gates
   * nothing, which is exactly the dead control the closed vocabulary exists to
   * prevent. Filtered here rather than in the adapter, because *which keys
   * exist* is domain knowledge and the store's job is only to hold rows.
   */
  private async readThrough(): Promise<readonly FeatureFlagOverrideRecord[]> {
    const rows = await this.store.listOverrides();
    return rows.filter((row) => isFeatureFlagKey(row.key));
  }
}

/**
 * What the audit trail digests.
 *
 * The value and where it came from, and nothing else. The label and the prose
 * describing what a flag gates are *code*, not state — they change when the
 * build changes, and including them would make every entry's digest differ from
 * the last after an unrelated copy edit, which destroys the only thing comparing
 * digests is for (ADR 0017).
 */
function auditable(flag: AdminFeatureFlag): Record<string, unknown> {
  return { key: flag.key, enabled: flag.enabled, source: flag.source };
}
