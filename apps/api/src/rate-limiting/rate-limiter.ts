/**
 * How much of the platform one caller may use in a window — slice H7a.
 *
 * BRD §10 requires *"rate limiting by IP, account, endpoint and risk level"* and
 * there has never been any, anywhere: not at the edge, not in the API, not in the
 * web app. `docs/SECURITY.md` §2.1 calls it the single largest gap in the list,
 * because it is cheap, already required, and the precondition for the adaptive
 * layers being anything more than a setting on somebody else's dashboard.
 *
 * ## What this layer is, and the three it is not
 *
 * `SECURITY.md` §4 separates three layers and says confusing them is why this is
 * usually built badly. This is **layer 3, the application** — the one nobody else
 * can build, because it is the only one that knows *who* a caller is. The edge
 * (Cloudflare, by IP and ASN) and the box (CrowdSec, by behaviour) are layers 1
 * and 2, both blocked on the domain, and neither is a substitute for this one:
 * one account requesting from four addresses is the signal, and four addresses
 * each requesting a little is not.
 *
 * **This slice keys on the account and nothing else, and that is a real limit
 * rather than a simplification.** The guard runs *after* `AuthGuard`, because an
 * account id is what `AuthGuard` produces — so **an unauthenticated flood is not
 * touched by this at all**. Slice H7b adds the per-IP half, and it carries the
 * contested decision: the API cannot see a caller's address on public routes
 * today, because `apps/web` deliberately does not forward `x-client-ip` for a
 * read that records nothing (ADR 0017, §10 data minimisation).
 *
 * ## Why a port
 *
 * CLAUDE.md's provider rule, and one reason specific to limiters: **a limiter
 * that cannot be faked makes every test that trips it flaky**, because the test
 * then depends on a real clock and a real shared counter. The fake in
 * `testing/fakes.ts` is deterministic and takes its own time source.
 */

/**
 * The vocabulary of things a limit can be about. A closed union on purpose.
 *
 * **Two tiers, not three, and the missing one is the point.** A `search` tier
 * was written first and then removed before this shipped: the only search route
 * in the system is `/public/listings`, which is unauthenticated, so nothing this
 * guard can see would ever have spent that allowance. An enum member with no
 * caller is the "built for a user who will never exist" shape this project cuts
 * on sight — and it would have been the one label in the metric that could never
 * appear, which reads as a broken counter rather than as an unused tier.
 *
 * **Slice H7b adds it**, along with the per-IP keying that makes a public route
 * limitable at all.
 */
export const RATE_LIMIT_TIERS = ['read', 'write'] as const;

export type RateLimitTier = (typeof RATE_LIMIT_TIERS)[number];

/**
 * What one caller is allowed, and what happens when the counter is unreachable.
 *
 * **`onStoreFailure` is required rather than defaulted, and that is the point.**
 * `SECURITY.md` §4 says the fail-open-or-closed question must be decided per
 * route and written down, *"because the default will otherwise be whichever the
 * library chose"*. A required field makes it a decision somebody typed.
 */
export interface RateLimitPolicy {
  readonly tier: RateLimitTier;
  readonly limit: number;
  readonly windowSeconds: number;
  /**
   * `allow` — a caller gets through when Redis is down. Correct for reads: a
   * broker outage should not take the dashboards offline, and the failure it
   * exposes us to is a flood we could not have measured anyway.
   *
   * `refuse` — a caller is turned away when Redis is down. Correct for anything
   * whose abuse is expensive and irreversible. **Nothing uses it yet**, and the
   * value exists because Phase 5's payment operations are the case it was
   * written for: replaying a capture is not a load problem.
   */
  readonly onStoreFailure: 'allow' | 'refuse';
}

/** What the counter said. `resetInSeconds` is what a `Retry-After` is built from. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetInSeconds: number;
}

/**
 * The shared counter behind a limit.
 *
 * **Counting must be atomic, not read-then-write.** A `GET` followed by a `SET`
 * would let two concurrent requests both read the same count and both decide
 * they were under the limit — the bug a limiter exists to prevent, reintroduced
 * inside it. `RedisRateLimiter` gets that from `INCR`, which is atomic on its
 * own; see its docblock for why it does not need a Lua script to be correct.
 */
export interface RateLimiter {
  /**
   * Count one use against `key`, and say whether it was allowed.
   *
   * **Throws when the counter is unreachable rather than deciding for the
   * caller.** Whether an outage means allow or refuse is `RateLimitPolicy`'s
   * answer and differs by route, so a port that swallowed the error would have
   * made that decision here, once, for everything.
   */
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

/**
 * The key one account's allowance is counted under.
 *
 * **Tier and account, never the route.** Two reads of different endpoints share
 * one read allowance, which is what makes the limit about *the platform's* cost
 * rather than about how many endpoints somebody found — a per-route key lets a
 * caller multiply their budget by walking the API surface.
 *
 * **The account id goes in the key, which is Redis, and never in a metric
 * label.** A key is ephemeral, expires with its window and is never exported;
 * a label is held in process memory and scraped into a system with none of
 * §10.1's retention or erasure rules.
 */
export function accountRateLimitKey(tier: RateLimitTier, accountId: string): string {
  return `ratelimit:${tier}:account:${accountId}`;
}
