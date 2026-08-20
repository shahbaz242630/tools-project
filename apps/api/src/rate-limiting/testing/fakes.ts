import type {
  RateLimitDecision,
  RateLimitPolicy,
  RateLimiter,
} from '../rate-limiter.js';

/**
 * A limiter that counts in memory, on a clock the test owns — slice H7a.
 *
 * **The reason CLAUDE.md's provider rule matters more here than usual.** A test
 * that has to trip a real limiter depends on a real shared counter and a real
 * clock: it either sleeps through a window, which makes the suite slow, or it
 * races the boundary, which makes it flaky. Session 44's whole flake class came
 * from tests billed for setup they did not control, and a limiter is the easiest
 * possible way to reintroduce it.
 *
 * **Time is injected rather than read.** `no-restricted-globals` bans `Date`
 * outside tests anyway, but the point is stronger than the rule: a fake that
 * called the process clock could not test the window boundary at all, because
 * there would be no way to stand on it.
 */
export class FakeRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; startedAtMs: number }>();

  /** Set by a test to make the next `consume` throw, as an unreachable Redis does. */
  failNext = false;

  constructor(private nowMs = 0) {}

  /** Move the clock. A test crosses a window boundary by calling this. */
  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
  }

  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    if (this.failNext) {
      this.failNext = false;
      /*
       * Rejects rather than throwing synchronously, because that is what an
       * unreachable Redis does — and a guard whose `try` only caught synchronous
       * throws would fail open by accident rather than by policy.
       */
      return Promise.reject(new Error('rate-limit counter unavailable'));
    }

    const windowMs = policy.windowSeconds * 1000;
    const existing = this.windows.get(key);
    const expired =
      existing !== undefined && this.nowMs - existing.startedAtMs >= windowMs;

    const window =
      existing === undefined || expired
        ? { count: 0, startedAtMs: this.nowMs }
        : existing;

    window.count += 1;
    this.windows.set(key, window);

    const elapsedMs = this.nowMs - window.startedAtMs;

    return Promise.resolve({
      allowed: window.count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - window.count),
      resetInSeconds: Math.ceil((windowMs - elapsedMs) / 1000),
    });
  }

  /** What a key has counted so far, for a test that wants to assert the key itself. */
  countFor(key: string): number {
    return this.windows.get(key)?.count ?? 0;
  }
}

/**
 * A limiter that allows everything, for boot sites that are not about limiting.
 *
 * **Named rather than implied.** `AppModuleOptions.rateLimiter` is required
 * precisely so no boot site can forget a security control by omission — but
 * "this test boots the whole application to check a booking endpoint" is a
 * legitimate reason to want no limit, and the honest way to express it is to say
 * so. A test that *is* about limiting reaches for `FakeRateLimiter` instead.
 */
export const allowAllRateLimiter: RateLimiter = {
  consume: (_key, policy) =>
    Promise.resolve({
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      resetInSeconds: policy.windowSeconds,
    }),
};
