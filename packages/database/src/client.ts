/**
 * Constructing the Prisma client.
 *
 * Prisma 7 requires a driver adapter rather than opening its own connection, so
 * the pool below is an ordinary `pg` pool — the same driver the raw PostGIS
 * queries in the Search & Location module will use later (BRD §4.2). One pool,
 * one place to tune it.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client.js';

export type { PrismaClient };

/**
 * Prisma's own namespace, re-exported for **one** thing: composing a raw
 * statement out of fragments (slice 3.2a).
 *
 * The tagged-template and empty-fragment helpers on it are what let the radius
 * query carry an *optional* predicate without either assembling the statement by
 * string concatenation — which loses parameterisation and invites injection — or
 * writing `($1 IS NULL OR "categoryId" = $1)`, which would change the plan of
 * **every** search including the unfiltered one slice 3.1c measured the Phase 3
 * exit gate against.
 *
 * **Exporting it does not widen what anybody may do.** The
 * `no-raw-sql-outside-search` invariant matches the tagged template as well as
 * the query methods, so using either of these outside
 * `apps/api/src/search-location/` fails the check — the same boundary BRD §4.2
 * draws and ADR 0044 records.
 */
export { Prisma } from '../generated/client.js';

export interface DatabaseOptions {
  /** Composed by @platform/config. Never read from a committed file. */
  readonly connectionString: string;

  /**
   * Maximum pooled connections.
   *
   * Deliberately small. Postgres allocates memory per backend and the box runs
   * two environments plus Redis (ADR 0009); a pool sized for a machine we do
   * not have would exhaust connections rather than queue for them. Queueing in
   * the application is visible and recoverable, `FATAL: too many clients` is
   * neither.
   */
  readonly maxConnections?: number;

  /** Fail a connection attempt rather than hanging a request indefinitely. */
  readonly connectionTimeoutMs?: number;
}

export const DEFAULT_MAX_CONNECTIONS = 10;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export function createPrismaClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis:
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  });

  return new PrismaClient({ adapter });
}
