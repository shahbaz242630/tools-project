import type { PrismaClient } from '@platform/database';
import type { FeatureFlagKey } from '@platform/contracts';
import type { FeatureFlagOverrideRecord, FeatureFlagStore } from './flag-store.js';

/**
 * Postgres-backed feature-flag overrides.
 *
 * Deliberately the thinnest adapter in the application. Everything interesting
 * about a flag — what the vocabulary is, which default applies, how long a value
 * may be cached, what happens when this class cannot answer — is domain
 * knowledge and lives in the service. This holds rows.
 *
 * In particular **it does not know which keys are legitimate**, and must not: a
 * store that filtered by the build's vocabulary would silently drop a row on
 * a deploy that renamed a flag, and the row is evidence of a decision somebody
 * made. The service ignores unknown keys when it reads; the row stays.
 */
export class PrismaFeatureFlagStore implements FeatureFlagStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listOverrides(): Promise<readonly FeatureFlagOverrideRecord[]> {
    // No `take`, and it is the one read in the system that needs none
    // (ADR 0035). The row count cannot exceed the number of keys the build
    // declares — there is no route that creates a row for anything else — so it
    // is bounded by the code rather than by a limit.
    const rows = await this.prisma.featureFlagOverride.findMany({
      orderBy: { key: 'asc' },
    });

    return rows.map(toRecord);
  }

  async set(
    key: FeatureFlagKey,
    enabled: boolean,
    changedById: string,
  ): Promise<FeatureFlagOverrideRecord> {
    // `upsert` rather than a read-then-write, because the read-then-write has a
    // window in it: two administrators switching the same flag at once would
    // both see no row and both insert, and one would fail on the primary key.
    // Here the second simply updates, which is the behaviour "rapid
    // disablement" (§9) needs — nobody hitting a kill switch should be told to
    // try again because a colleague hit it first.
    const row = await this.prisma.featureFlagOverride.upsert({
      where: { key },
      create: { key, enabled, changedById },
      update: { enabled, changedById },
    });

    return toRecord(row);
  }
}

interface FeatureFlagOverrideRow {
  id: string;
  key: string;
  enabled: boolean;
  changedById: string;
  updatedAt: Date;
}

/**
 * `updatedAt` becomes `changedAt`, and the rename is deliberate.
 *
 * The column is Prisma's automatic write timestamp; the port's field is a
 * domain fact — when somebody last switched this flag. They coincide because
 * the only write this table has *is* a switch, and naming the port's field after
 * the ORM's mechanism would tie a contract the admin page reads to an
 * implementation detail that could stop being true the moment a second kind of
 * write exists.
 */
function toRecord(row: FeatureFlagOverrideRow): FeatureFlagOverrideRecord {
  return {
    id: row.id,
    key: row.key,
    enabled: row.enabled,
    changedById: row.changedById,
    changedAt: row.updatedAt,
  };
}
