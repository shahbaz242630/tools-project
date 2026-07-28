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
