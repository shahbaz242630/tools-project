/**
 * Ask each way of proving a second factor, in order, until one satisfies.
 *
 * This is the composition rule for {@link AdminSecondFactor}, not a provider
 * adapter — it talks to nothing outside the process. It lives in its own file
 * because it holds two decisions that are easy to undo and expensive to get
 * wrong.
 */

import type { Logger } from '@platform/observability';
import { MAX_SECOND_FACTOR_AGE_MINUTES } from './admin-second-factor.js';
import type {
  AdminSecondFactor,
  SecondFactorEvidence,
  SecondFactorAnswer,
} from './admin-second-factor.js';

/**
 * What the chain concluded, and what it asked to get there.
 *
 * `attempts` carries every prover that answered with an age — fresh or stale —
 * in the order asked, and exists solely so a refusal can be diagnosed. An
 * administrator locked out of their own console needs to see whether their
 * claim was *absent* or merely *old*; a 403 with no detail sends them looking
 * at the wrong thing, which is a failure mode ADR 0021's correction of
 * 2026-08-01 already paid for once.
 */
export interface SecondFactorDecision {
  readonly proof: SecondFactorAnswer | null;
  readonly attempts: readonly SecondFactorAnswer[];
}

export interface SecondFactorChainOptions {
  /**
   * The provers, **in the order they are asked**. Order is load-bearing — see
   * the note on {@link SecondFactorChain.prove}.
   */
  readonly provers: readonly AdminSecondFactor[];
  readonly logger: Logger;
  /** Overridable only so a test can exercise the boundary without waiting. */
  readonly maximumAgeMinutes?: number;
}

export class SecondFactorChain {
  private readonly provers: readonly AdminSecondFactor[];
  private readonly logger: Logger;
  private readonly maximumAgeMinutes: number;

  constructor(options: SecondFactorChainOptions) {
    // **Copied, not aliased.** `readonly AdminSecondFactor[]` stops *us*
    // mutating it and does nothing about the caller, who holds a plain array.
    // A prover pushed in after construction would be asked by the guard while
    // `/me` still reported the boolean read at boot — which is precisely the
    // "two sources disagree exactly when it matters" divergence this design
    // claims to have removed.
    this.provers = [...options.provers];
    this.logger = options.logger;
    this.maximumAgeMinutes = options.maximumAgeMinutes ?? MAX_SECOND_FACTOR_AGE_MINUTES;
  }

  /**
   * Whether any installed prover admits without a real second factor.
   *
   * Read by `/me` so the admin layout can carry ADR 0030's banner. It is
   * derived from the chain rather than from a second reading of the
   * environment **on purpose**: two flags answering "what is configured" and
   * "what is enforced" would disagree exactly when it matters, which is the
   * reason ADR 0030 refused to let the web app hold one of its own.
   */
  /**
   * The provers, in the order they are asked.
   *
   * Exposed so the composition root's ordering can be asserted — see
   * `compose-second-factor.ts` for why that is not merely tidiness — and so a
   * boot line can say what was installed rather than leaving it inferred.
   */
  get proverNames(): readonly string[] {
    return this.provers.map((prover) => prover.name);
  }

  /** The bound this chain actually applies, so a log line cannot claim another. */
  get maximumAge(): number {
    return this.maximumAgeMinutes;
  }

  get bypassesSecondFactor(): boolean {
    return this.provers.some((prover) => prover.bypassesSecondFactor === true);
  }

  /**
   * Ask each prover until one proves a factor **within the maximum age**.
   *
   * Two things here are deliberate and both look like details.
   *
   * **It short-circuits on the first prover that proves _acceptably_, not on
   * the first that answers at all.** A prover answering with a stale age must
   * not stop a later one answering with a fresh age, or a Clerk session
   * verified twenty hours ago would mask a Cloudflare Access assertion from
   * five minutes ago and refuse somebody who had just presented a security key.
   * That is why the freshness bound lives here rather than in the caller.
   *
   * **Order is the escape hatch's safety property.** ADR 0030 required the
   * bypass to be consulted only *after* the real check had already failed, so
   * that on the day it is wrongly enabled the rule it replaces has still been
   * evaluated and logged. Short-circuiting preserves that exactly, provided
   * `DevelopmentSecondFactor` is last in `provers`. `composeSecondFactor` is
   * what puts it there and is tested for exactly that — the ordering is a
   * property of the composition root, so asserting it here against a
   * hand-built array would prove nothing about what the application runs.
   *
   * **A prover that throws is unproven, not an error.** Verifying an assertion
   * may involve a rotating key set fetched over the network, and an outage at
   * the provider must degrade to a refusal rather than a 500 on every admin
   * request — fail closed, and say so in a log rather than to the caller.
   */
  async prove(evidence: SecondFactorEvidence): Promise<SecondFactorDecision> {
    const attempts: SecondFactorAnswer[] = [];

    for (const prover of this.provers) {
      const ageMinutes = await this.ask(prover, evidence);
      if (ageMinutes === null) continue;

      const attempt: SecondFactorAnswer = { ageMinutes, provenBy: prover.name };
      attempts.push(attempt);

      if (ageMinutes <= this.maximumAgeMinutes) {
        return { proof: attempt, attempts };
      }
    }

    return { proof: null, attempts };
  }

  private async ask(
    prover: AdminSecondFactor,
    evidence: SecondFactorEvidence,
  ): Promise<number | null> {
    let age: number | null;
    try {
      age = await prover.ageMinutes(evidence);
    } catch (error) {
      this.logger.warn('a second-factor prover failed and was read as unproven', {
        prover: prover.name,
        error,
      });
      return null;
    }

    if (age === null) return null;

    // **A nonsensical age is unproven, not fresh.** `age <= maximum` admits for
    // any negative number and for `-Infinity`, so an adapter returning one —
    // a clock skew subtracting two timestamps the wrong way round, a provider
    // field read as a number when it was not — would satisfy the strongest
    // control in the system by being *more* wrong rather than less.
    //
    // `NaN` and `Infinity` already refuse, because every comparison with `NaN`
    // is false and `Infinity` exceeds any bound. Those two fail closed by
    // accident; this makes the whole class fail closed on purpose.
    //
    // `ClerkSecondFactor` cannot produce any of them — `secondFactorAge` maps
    // a negative `fva` to null already — but the port's contract permits them
    // and the next adapter is the one that computes an age from a timestamp.
    if (!Number.isFinite(age) || age < 0) {
      this.logger.warn('a second-factor prover answered with a nonsensical age', {
        prover: prover.name,
        ageMinutes: age,
      });
      return null;
    }

    return age;
  }
}
