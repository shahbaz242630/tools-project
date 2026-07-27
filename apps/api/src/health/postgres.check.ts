import type { DependencyCheck } from './dependency-check.js';

/**
 * The slice of a Postgres client this check needs.
 *
 * Narrow on purpose: it keeps `pg` out of everything but the composition root,
 * and it means the failure paths can be tested without a database. A fake that
 * hangs forever is the only practical way to exercise the timeout, and no real
 * Postgres can be persuaded to do that on demand.
 */
export interface SqlClient {
  query(sql: string): Promise<unknown>;
}

export class PostgresCheck implements DependencyCheck {
  readonly name = 'postgres';

  constructor(private readonly client: SqlClient) {}

  async probe(): Promise<void> {
    // Cheapest statement that proves the connection is usable rather than
    // merely open: it round-trips through the query planner without touching a
    // table, so it stays valid before any migration has run.
    await this.client.query('SELECT 1');
  }
}
