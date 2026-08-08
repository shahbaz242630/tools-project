import { Time } from '@platform/core';
import { createRecordingLogger } from '@platform/observability/testing';
import type { RecordingLogger } from '@platform/observability/testing';
import type { FeatureFlagKey } from '@platform/contracts';
import { createAuditFakes } from '../../audit/testing/fakes.js';
import type { AuditFakes } from '../../audit/testing/fakes.js';
import { FeatureFlagsService } from '../feature-flags.service.js';
import type { FeatureFlagOverrideRecord, FeatureFlagStore } from '../flag-store.js';

/**
 * Overrides in memory.
 *
 * Behavioural rather than a recording spy: `set` really upserts, so a test that
 * switches a flag twice sees one row, and `listOverrides` really returns what
 * was written. A double that only recorded calls would let a test pass while the
 * evaluator read nothing.
 */
export class InMemoryFeatureFlagStore implements FeatureFlagStore {
  private readonly rows = new Map<string, FeatureFlagOverrideRecord>();

  /**
   * Fail every read, for testing the fail-safe.
   *
   * The one behaviour that cannot be produced by seeding: `isEnabled` must
   * return the declared default rather than throwing when the database is
   * unreachable, and there is no arrangement of rows that exercises it.
   */
  private failure: Error | null = null;

  failsWith(error: Error): this {
    this.failure = error;
    return this;
  }

  recovers(): this {
    this.failure = null;
    return this;
  }

  /** Seed a row without going through a route or an audit write. */
  seed(key: string, enabled: boolean, changedById = SEED_ADMIN): this {
    this.rows.set(key, {
      id: this.idFor(key),
      key,
      enabled,
      changedById,
      changedAt: Time.nowUtc(),
    });
    return this;
  }

  /**
   * A stable uuid per key, so a row seeded and then re-set keeps its identity —
   * which is what the real table's unique constraint on `key` guarantees. A
   * fresh uuid per write would let an assertion about the audit target pass here
   * and fail against Postgres.
   */
  private idFor(key: string): string {
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing.id;

    this.minted += 1;
    return `00000000-0000-4000-8000-${String(this.minted).padStart(12, '0')}`;
  }

  private minted = 0;

  listOverrides(): Promise<readonly FeatureFlagOverrideRecord[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    // Sorted by key, matching the real adapter's `orderBy`. A double returning
    // insertion order would let an assertion about ordering pass here and fail
    // against Postgres.
    return Promise.resolve(
      [...this.rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    );
  }

  set(
    key: FeatureFlagKey,
    enabled: boolean,
    changedById: string,
  ): Promise<FeatureFlagOverrideRecord> {
    if (this.failure !== null) return Promise.reject(this.failure);

    const row = {
      id: this.idFor(key),
      key,
      enabled,
      changedById,
      changedAt: Time.nowUtc(),
    };
    this.rows.set(key, row);
    return Promise.resolve(row);
  }

  /** Everything stored, for asserting that a refused write left nothing behind. */
  all(): readonly FeatureFlagOverrideRecord[] {
    return [...this.rows.values()];
  }
}

const SEED_ADMIN = '00000000-0000-4000-8000-0000000000ff';

export interface FeatureFlagFakes {
  readonly store: InMemoryFeatureFlagStore;
  readonly audit: AuditFakes;
  readonly logger: RecordingLogger;
  readonly service: FeatureFlagsService;
  /**
   * Move the service's clock, so the cache's expiry is provable without waiting
   * ten seconds. Advancing past `FLAG_CACHE_TTL_MS` must make the next read hit
   * the store again.
   */
  advance(milliseconds: number): void;
}

export function createFeatureFlagFakes(audit = createAuditFakes()): FeatureFlagFakes {
  const store = new InMemoryFeatureFlagStore();
  const logger = createRecordingLogger();

  let clock = 1_000_000;
  const now = (): number => clock;

  return {
    store,
    audit,
    logger,
    service: new FeatureFlagsService(store, audit.service, logger.logger, now),
    advance: (milliseconds) => {
      clock += milliseconds;
    },
  };
}
