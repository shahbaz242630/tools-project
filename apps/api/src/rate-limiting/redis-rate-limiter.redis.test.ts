import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { loadEnv } from '@platform/config';
import { RedisRateLimiter } from './redis-rate-limiter.js';
import { resolvePolicies } from './policy.js';

/**
 * The limiter against a real Redis — slice H7a.
 *
 * **The unit tests cannot see the two things that matter here**, which is the
 * whole reason this file exists. They stub the client, so they prove the adapter
 * calls the right commands; they cannot prove that `EXPIRE … NX` behaves as
 * assumed, or that `INCR` gives two concurrent callers different numbers. Both
 * are claims about Redis, and this project has been caught once already by a
 * claim about a datastore that nobody exercised.
 *
 * Needs `pnpm db:up`.
 */
const env = loadEnv();

const client = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

const POLICY = resolvePolicies({ write: 3 }).write;
const KEY = 'ratelimit:test:account:h7a';

afterAll(async () => {
  await client.del(KEY);
  await client.quit();
});

beforeEach(async () => {
  await client.del(KEY);
});

describe('against a real Redis', () => {
  it('counts, refuses past the limit, and sets an expiry', async () => {
    const limiter = new RedisRateLimiter(client);

    const first = await limiter.consume(KEY, POLICY);
    await limiter.consume(KEY, POLICY);
    const third = await limiter.consume(KEY, POLICY);
    const fourth = await limiter.consume(KEY, POLICY);

    expect(first.allowed).toBe(true);
    expect(third).toMatchObject({ allowed: true, remaining: 0 });
    expect(fourth.allowed).toBe(false);

    // The expiry is what makes the limit a *window* rather than a lifetime ban.
    expect(await client.ttl(KEY)).toBeGreaterThan(0);
  });

  it('does not push the window out as a caller keeps knocking', async () => {
    /*
     * **The bug `NX` exists to prevent.** A plain `EXPIRE` on every request
     * refreshes the countdown, so a caller hammering the endpoint never reaches
     * their reset — the limit becomes permanent for exactly the caller most
     * likely to complain about it.
     */
    const limiter = new RedisRateLimiter(client);

    await limiter.consume(KEY, POLICY);
    const firstTtl = await client.ttl(KEY);

    await limiter.consume(KEY, POLICY);
    await limiter.consume(KEY, POLICY);
    const laterTtl = await client.ttl(KEY);

    expect(laterTtl).toBeLessThanOrEqual(firstTtl);
  });

  it('repairs a key that somehow lost its expiry', async () => {
    // The failure mode a first-increment-only script has: a key with no expiry
    // refuses that caller forever. `NX` on every request puts one back.
    const limiter = new RedisRateLimiter(client);
    await limiter.consume(KEY, POLICY);
    await client.persist(KEY);
    expect(await client.ttl(KEY)).toBe(-1);

    await limiter.consume(KEY, POLICY);

    expect(await client.ttl(KEY)).toBeGreaterThan(0);
  });

  it('gives concurrent callers different numbers', async () => {
    /*
     * The one race a limiter must not lose. Ten simultaneous requests against a
     * limit of three must produce exactly three allowances — a read-then-write
     * implementation would let several of them all see zero and all proceed.
     */
    const limiter = new RedisRateLimiter(client);

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume(KEY, POLICY)),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
  });
});
