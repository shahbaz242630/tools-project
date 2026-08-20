import type {
  RateLimitDecision,
  RateLimitPolicy,
  RateLimiter,
} from './rate-limiter.js';

/**
 * The slice of a Redis client this needs. See `PingClient` in `health/` for why.
 *
 * **Narrow because `ioredis` may not be imported here.**
 * `no-provider-sdk-outside-adapter` names `apps/api/src/main.ts` as the only file
 * in the API allowed to import it, and that is this project's shape rather than a
 * loophole: the composition root constructs the client and hands narrow
 * interfaces to everything else. It also means this limiter **reuses the one
 * connection the API already holds** rather than opening a second.
 */
export interface CountingClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number, mode: 'NX'): Promise<number>;
  ttl(key: string): Promise<number>;
}

/**
 * Count one use against a key and say whether it was allowed.
 *
 * ## Three commands rather than one script, and why that is not a compromise
 *
 * The obvious implementation is a Lua script, so the whole decision is one atomic
 * round trip. **The atomicity that matters is already there without it**: `INCR`
 * is atomic on its own, so two concurrent requests get 1 and 2 and never both
 * get 1 — which is the only race a limiter must not lose. `EXPIRE … NX` is
 * atomic and idempotent, and `TTL` is a read.
 *
 * What a script would buy is *snapshot* consistency across the three, and the
 * only thing that would change is the reported `resetInSeconds` drifting by a
 * command's worth of time. That is a `Retry-After` a second out, not a limit
 * that fails to fire.
 *
 * **What the three-command form buys instead is the failure mode.** The classic
 * bug here is `INCR` succeeding and `EXPIRE` being lost to a reconnect or a
 * failover, leaving a key with **no expiry at all** — which locks that caller out
 * permanently while looking exactly like a limiter working correctly. A script
 * that sets the expiry only on the first increment has that bug. Calling
 * `EXPIRE … NX` on **every** request does not: `NX` makes it a no-op when an
 * expiry exists, so a lost one is repaired by the next request through.
 *
 * `NX` needs Redis 7.0; the stack runs 7.4 locally and `redis:7-alpine` in
 * `infra/compose`.
 *
 * ## A fixed window, with its weakness stated rather than hidden
 *
 * A caller who spends a full allowance at the end of one window and another at
 * the start of the next gets `2 × limit` across the boundary. A sliding window
 * would not, and costs a sorted set per caller — memory proportional to requests
 * rather than to callers. **For a first limiter protecting reads, twice the
 * budget for one instant is not the failure worth paying for**: the flood this
 * stops runs for minutes, not for one boundary. `SECURITY.md` §4's adaptive work
 * is where that changes.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly client: CountingClient) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const count = await this.client.incr(key);

    // Every request, not just the first — see the class docblock. `NX` makes it
    // a no-op when an expiry is already set, so this repairs a lost one rather
    // than pushing the window out and starving the reset.
    await this.client.expire(key, policy.windowSeconds, 'NX');

    const ttl = await this.client.ttl(key);

    /*
     * **Checked rather than trusted.** A client that reconnected mid-call, or a
     * Redis replaced by something that is not Redis, can answer with a shape
     * this does not expect. Left alone, a non-numeric count becomes
     * `remaining: NaN` and `allowed: false` — or worse, `allowed: true` for
     * everything. A limiter must not fail in the direction of letting traffic
     * through quietly, so it refuses to interpret what it cannot read.
     */
    if (!Number.isFinite(count)) {
      throw new Error(`unexpected reply from INCR: ${JSON.stringify(count)}`);
    }

    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      // Never negative: a caller forty over the limit is told 0 left, not -40.
      remaining: Math.max(0, policy.limit - count),
      /*
       * `TTL` answers -1 for a key with no expiry and -2 for one that is gone —
       * both of which mean "no useful reset to report" rather than a duration.
       * Falling back to the window is the honest answer and keeps `Retry-After`
       * a positive number of seconds, which is the only thing it may be.
       */
      resetInSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : policy.windowSeconds,
    };
  }
}
