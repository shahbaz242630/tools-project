import { describe, expect, it } from 'vitest';
import { RedisRateLimiter } from './redis-rate-limiter.js';
import type { CountingClient } from './redis-rate-limiter.js';
import { resolvePolicies } from './policy.js';

const POLICY = resolvePolicies({ write: 2 }).write;

/** A client that answers what the test says, and records what it was asked. */
function clientReturning(
  counts: number[],
  ttl = 42,
): CountingClient & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;

  return {
    calls,
    incr: (key) => {
      calls.push(`incr ${key}`);
      const value = counts[index] ?? counts.at(-1) ?? 1;
      index += 1;
      return Promise.resolve(value);
    },
    expire: (key, seconds, mode) => {
      calls.push(`expire ${key} ${seconds} ${mode}`);
      return Promise.resolve(1);
    },
    ttl: () => Promise.resolve(ttl),
  };
}

describe('the Redis rate limiter (slice H7a)', () => {
  it('allows a caller at exactly the limit and refuses the next', async () => {
    // The off-by-one worth pinning: a limit of 2 means two requests succeed.
    const limiter = new RedisRateLimiter(clientReturning([1, 2, 3]));

    await expect(limiter.consume('k', POLICY)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(limiter.consume('k', POLICY)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(limiter.consume('k', POLICY)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('sets the expiry on every request, with NX', async () => {
    /*
     * **The failure this prevents is a key with no expiry**, which refuses that
     * caller forever while looking exactly like a limiter working. A script that
     * set the expiry only on the first increment has that bug if the first
     * `EXPIRE` is lost to a reconnect; `NX` on every request repairs it and is a
     * no-op the rest of the time.
     */
    const client = clientReturning([1, 2]);
    const limiter = new RedisRateLimiter(client);

    await limiter.consume('k', POLICY);
    await limiter.consume('k', POLICY);

    expect(client.calls.filter((call) => call.startsWith('expire'))).toEqual([
      'expire k 60 NX',
      'expire k 60 NX',
    ]);
  });

  it('never reports negative headroom', async () => {
    const limiter = new RedisRateLimiter(clientReturning([40]));

    await expect(limiter.consume('k', POLICY)).resolves.toMatchObject({ remaining: 0 });
  });

  it('falls back to the window when the key has no usable TTL', async () => {
    // `TTL` answers -1 for a key with no expiry and -2 for one that is gone.
    // Passing either through would produce a negative `Retry-After`, which is
    // not a value that header may take.
    const limiter = new RedisRateLimiter(clientReturning([1], -1));

    await expect(limiter.consume('k', POLICY)).resolves.toMatchObject({
      resetInSeconds: 60,
    });
  });

  it('refuses to interpret a reply it cannot read', async () => {
    /*
     * A limiter must not fail in the direction of letting traffic through
     * quietly. A non-numeric count left alone becomes `remaining: NaN` and an
     * `allowed` that means nothing — so this throws, and the guard's policy
     * decides what an unreachable counter means.
     */
    const client = clientReturning([]);
    const limiter = new RedisRateLimiter({
      ...client,
      incr: () => Promise.resolve(Number.NaN),
    });

    await expect(limiter.consume('k', POLICY)).rejects.toThrow(/unexpected reply/);
  });
});
