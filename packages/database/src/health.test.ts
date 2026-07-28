import { describe, expect, it, vi } from 'vitest';
import { ping } from './health.js';
import type { Pingable } from './health.js';

const clientThat = (behaviour: () => Promise<unknown>): Pingable => ({
  $queryRaw: vi.fn(behaviour),
});

describe('ping', () => {
  it('resolves when the query succeeds', async () => {
    await expect(
      ping(clientThat(async () => [{ '?column?': 1 }])),
    ).resolves.toBeUndefined();
  });

  it('issues a query that touches no table', async () => {
    // The property that matters: it must work on a database where migrations
    // have not run, so a fresh box reports "reachable" rather than "broken".
    const client = clientThat(async () => []);
    await ping(client);

    const [strings] = vi.mocked(client.$queryRaw).mock.calls[0] ?? [];
    expect(strings?.join('')).toBe('SELECT 1');
  });

  it('propagates a connection failure rather than swallowing it', async () => {
    // The caller decides what an unreachable database means. Returning a
    // boolean here would lose the reason, which is what gets logged.
    const failure = new Error('connect ECONNREFUSED');
    await expect(ping(clientThat(() => Promise.reject(failure)))).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('never resolves early on a hanging connection', async () => {
    // The realistic database failure is a socket that accepts and then never
    // answers. `ping` must not paper over that with its own timeout — bounding
    // the probe is the readiness service's job, and doing it in both places
    // would make the effective timeout the shorter of two numbers nobody
    // remembers setting.
    let settled = false;
    void ping(clientThat(() => new Promise(() => {}))).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  });
});
