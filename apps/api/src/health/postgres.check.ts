import type { DependencyCheck } from './dependency-check.js';

/**
 * The slice of the database this check needs.
 *
 * Narrower than it was: it used to take a `pg` client and issue `SELECT 1`
 * itself. The query moved into `@platform/database` so raw SQL stays confined
 * to infrastructure and the Search & Location module (ADR 0004), and what is
 * left here is the shape a fake has to satisfy.
 *
 * A fake that hangs forever is the only practical way to exercise the readiness
 * timeout — no real Postgres can be persuaded to do that on demand.
 */
export interface DatabasePing {
  ping(): Promise<void>;
}

export class PostgresCheck implements DependencyCheck {
  readonly name = 'postgres';

  constructor(private readonly database: DatabasePing) {}

  async probe(): Promise<void> {
    await this.database.ping();
  }
}
