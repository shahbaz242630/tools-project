import type { RateLimitPolicy, RateLimitTier } from './rate-limiter.js';

/**
 * What each tier allows — slice H7a.
 *
 * ## These are configuration, and the shape says which part
 *
 * CLAUDE.md: *if it might change without a deploy, it is configuration.* The
 * **numbers** plainly might — a limit that turns out to be wrong is discovered
 * under traffic, at the worst possible moment, and needing a release to raise it
 * is how an incident gets longer. They are read from the environment.
 *
 * **The tiers themselves are code, deliberately.** A tier is a claim about what a
 * kind of request costs us, which is a thing the code knows and an operator does
 * not; and `RATE_LIMIT_TIERS` is a closed union precisely so a metric label
 * cannot be minted by an environment variable. Adding one is a change to the
 * vocabulary, which is a review, not a restart.
 *
 * ## Where the numbers came from
 *
 * Not from a benchmark, and this is the honest note rather than a false
 * precision. Nothing is public, there is no traffic to characterise, and a limit
 * tuned against zero users would be a guess wearing a measurement's clothes.
 * They are set where **a human being cannot plausibly reach them and a script
 * trivially can**: a person clicking through their bookings as fast as they can
 * read is doing a few requests a minute, not sixty.
 *
 * The right time to revisit them is when there is traffic to look at — and the
 * `rate_limit_decisions_total` metric is what makes that a measurement rather
 * than another guess. **A tier that never refuses anybody is either correct or
 * useless, and only the counter can say which.**
 */
export const DEFAULT_LIMITS: Readonly<Record<RateLimitTier, number>> = Object.freeze({
  /** Ordinary authenticated reads: dashboards, a listing, a booking. */
  read: 300,
  /**
   * Anything that changes state. Lower because it costs a transaction and
   * because the abuse worth stopping — a request submitted a thousand times — is
   * a write.
   */
  write: 60,
});

/** One minute, for every tier. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Build the policies, taking any overrides the environment supplied.
 *
 * **An override that is not a positive whole number is refused rather than
 * ignored**, because the failure it prevents is silent: a typo that fell back to
 * a default would leave an operator believing they had raised a limit during an
 * incident. `0` is refused for the same reason — it reads like "no limit" and
 * would mean "refuse everybody".
 */
export function resolvePolicies(
  overrides: Partial<Record<RateLimitTier, number | undefined>> = {},
): Readonly<Record<RateLimitTier, RateLimitPolicy>> {
  const build = (tier: RateLimitTier): RateLimitPolicy => {
    const override = overrides[tier];
    if (override !== undefined && (!Number.isInteger(override) || override < 1)) {
      throw new Error(
        `Rate limit for "${tier}" must be a whole number of requests above zero, got ${String(override)}.`,
      );
    }

    return {
      tier,
      limit: override ?? DEFAULT_LIMITS[tier],
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      /*
       * **`allow`, and it is a decision rather than a default.** `SECURITY.md`
       * §4 requires this to be settled per route and written down. Every tier
       * here protects a read or an ordinary write on a platform that is not
       * public; a Redis outage taking the dashboards and bookings offline would be a
       * self-inflicted outage in exchange for stopping a flood that, with no
       * counter, we could not have measured anyway.
       *
       * **Phase 5 is where this stops being right.** A payment operation replayed
       * during a broker outage is not a load problem, and `'refuse'` exists on
       * `RateLimitPolicy` for exactly that — unused today, so the case is
       * expressible before it arrives rather than after.
       */
      onStoreFailure: 'allow',
    };
  };

  return Object.freeze({
    read: build('read'),
    write: build('write'),
  });
}
