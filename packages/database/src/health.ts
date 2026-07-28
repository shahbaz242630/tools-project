/**
 * Liveness probing for the database connection.
 *
 * Lives here rather than in the API because it needs raw SQL, and raw SQL is
 * confined to infrastructure and to the Search & Location module (ADR 0004,
 * BRD §4.2). Exposing it as a function keeps the rule intact everywhere else:
 * the API calls `ping()` and never writes a query.
 */

import type { PrismaClient } from '../generated/client.js';

/** The slice of the client this needs. Narrow, so a test can fake it. */
export interface Pingable {
  // invariant-ok: no-raw-sql-outside-search — declares the shape of Prisma's raw-query method, does not issue one.
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * Assert the connection is usable, not merely open.
 *
 * `SELECT 1` round-trips through the query planner without touching a table, so
 * it stays valid before any migration has run — which matters, because the
 * readiness endpoint has to give a sensible answer on a freshly provisioned box
 * where the schema does not exist yet.
 *
 * Deliberately not a model query such as `user.count()`: that would fail on an
 * unmigrated database and report "database unreachable" when the database is
 * fine and the migration simply has not run.
 */
export async function ping(client: Pingable): Promise<void> {
  // The rule keeps domain reads behind the ORM and PostGIS queries inside
  // Search & Location. A connection probe is neither, and Prisma offers no
  // non-raw way to check a connection without touching a table.
  //
  // invariant-ok: no-raw-sql-outside-search — a connection probe, not a domain read.
  await client.$queryRaw`SELECT 1`;
}

export type { PrismaClient };
