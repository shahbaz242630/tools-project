import { describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
} from './client.js';

/** Deliberately unreachable. Nothing here may depend on a live database. */
const UNREACHABLE = 'postgresql://nobody:nothing@127.0.0.1:1/none';

describe('createPrismaClient', () => {
  it('constructs without connecting', async () => {
    // The property that matters most. If constructing opened a socket, the API
    // would crash at boot whenever the database was down — turning a
    // recoverable dependency outage into a container that will not start, and
    // making the readiness endpoint pointless because nothing would be alive to
    // serve it.
    const client = createPrismaClient({ connectionString: UNREACHABLE });
    expect(client).toBeDefined();
    await client.$disconnect();
  });

  it('accepts an explicit pool size and timeout', () => {
    const client = createPrismaClient({
      connectionString: UNREACHABLE,
      maxConnections: 3,
      connectionTimeoutMs: 250,
    });
    expect(client).toBeDefined();
  });

  it('has a pool bounded well below a small box, and a bounded connect timeout', () => {
    // Both are engineering constants rather than configuration, so they are
    // asserted here — a later change that raises them silently is exactly the
    // sort of thing that exhausts Postgres backends on a shared VPS (ADR 0009),
    // or hangs a request forever against a database that accepts and stalls.
    expect(DEFAULT_MAX_CONNECTIONS).toBeLessThanOrEqual(10);
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('disconnects cleanly even though it never connected', async () => {
    // Shutdown runs this path on every deploy, including deploys during an
    // outage. It must not reject — a rejecting close is what made the API's
    // Redis shutdown look like a crash (see @platform/runtime).
    const client = createPrismaClient({ connectionString: UNREACHABLE });
    await expect(client.$disconnect()).resolves.not.toThrow();
  });
});
