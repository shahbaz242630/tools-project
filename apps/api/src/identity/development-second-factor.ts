/**
 * Admit an administrator with no second factor, in local development only.
 *
 * This is ADR 0030's escape hatch, moved out of `AuthGuard` and behind the
 * {@link AdminSecondFactor} port by slice H8a. **Nothing about it is weaker
 * than the branch it replaces, and two things are stronger.**
 *
 * The guard no longer contains a bypass at all: it asks the chain and refuses
 * when the answer is null, so the one place that must never be able to say "no
 * credential needed" no longer has a branch that says it. And because the
 * chain short-circuits on the first prover that proves *acceptably*, this one
 * is only ever reached after every real prover has already answered and
 * failed — which is exactly the ordering ADR 0030 required, now a property of
 * the composition rather than a comment asking the next reader to preserve it.
 *
 * **It still cannot reach production.** `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA`
 * is validated by `loadIdentityEnv`, which refuses to load under
 * `NODE_ENV=production` — the process exits naming the variable before Nest is
 * constructed. This class is simply never put in the chain when the flag is
 * off, so an environment that cannot set the flag cannot install the adapter.
 *
 * **It removes the second factor and nothing else.** Role, suspension and
 * session verification are untouched, and they are not this class's business:
 * they are checked elsewhere in the guard, before and around the point this is
 * consulted. Tests pin each of them still refusing while this is installed.
 *
 * See ADR 0053, which supersedes ADR 0030.
 */

import type { Logger } from '@platform/observability';
import type { AdminSecondFactor, SecondFactorEvidence } from './admin-second-factor.js';

/**
 * The variable that installs this adapter.
 *
 * A constant rather than a literal in the log line, so that a search for the
 * variable name finds the requests it admitted and not merely the banner. ADR
 * 0030 required exactly that and the guard used to hold this string; it moved
 * here with the behaviour.
 */
export const ADMIN_MFA_BYPASS_VARIABLE = 'DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA';

export class DevelopmentSecondFactor implements AdminSecondFactor {
  readonly name = 'development-bypass';

  /** Declared true so `/me` can raise the banner on every admin page. */
  readonly bypassesSecondFactor = true;

  constructor(private readonly logger: Logger) {}

  ageMinutes(evidence: SecondFactorEvidence): Promise<number | null> {
    // **Announced on every request it admits**, not merely at startup. A
    // banner tells whoever is looking at a page; this tells whoever is reading
    // logs afterwards which requests were admitted under the exception, which
    // is the question asked after the fact rather than during.
    this.logger.warn('admitted an admin request with no verified second factor', {
      clerkUserId: evidence.session.clerkUserId,
      reason: ADMIN_MFA_BYPASS_VARIABLE,
    });

    // Zero, not the maximum: "verified just now" rather than "verified as long
    // ago as is still allowed". The distinction matters if the bound is ever
    // lowered — a value pinned to the limit would start failing the moment
    // somebody tightened it, for reasons that would look like a real refusal.
    return Promise.resolve(0);
  }
}
