/**
 * Build the second-factor chain the application runs with.
 *
 * **This exists so the prover order can be tested.** It was four lines inside
 * `main.ts` until a review pointed out that the ordering guarantee — the real
 * prover is asked before the exception, always — was a property of an array
 * literal in the composition root, which no test constructs and no test can
 * see. Every chain test built its own array, so reordering `main.ts` would have
 * left the whole suite green while silently discarding ADR 0030's central
 * safety property.
 *
 * A function that returns the chain is testable; a literal in `main.ts` is not.
 */

import type { Logger } from '@platform/observability';
import type { AdminSecondFactor } from './admin-second-factor.js';
import { ClerkSecondFactor } from './clerk-second-factor.js';
import { CloudflareAccessSecondFactor } from './cloudflare-access-second-factor.js';
import { DevelopmentSecondFactor } from './development-second-factor.js';
import { SecondFactorChain } from './second-factor-chain.js';

export interface SecondFactorComposition {
  /**
   * `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA`, already parsed.
   *
   * Passed in rather than read here, so this function states no opinion about
   * where it is running and both regimes are reachable from a test.
   * `loadIdentityEnv` is what refuses the flag under `NODE_ENV=production`, and
   * it does so before Nest is constructed.
   */
  readonly allowWithoutSecondFactor: boolean;

  /**
   * Cloudflare Access, when it is in front of this environment.
   *
   * Absent on a laptop and in CI, because Access protects a public hostname and
   * cannot see `localhost` — so the prover is not merely inert there, it is not
   * constructed. `loadIdentityEnv` refuses a half-configured pair, so this is
   * either wholly present or wholly absent by the time it reaches here.
   */
  readonly access?: { readonly teamDomain: string; readonly audience: string };
  readonly logger: Logger;
}

export function composeSecondFactor(
  options: SecondFactorComposition,
): SecondFactorChain {
  // The real prover first. Not a style choice: the chain short-circuits on the
  // first prover that proves within the age bound, so anything after this is
  // reached only once Clerk has been asked and has failed — which is exactly
  // ADR 0030's requirement that the rule the exception replaces is still
  // evaluated and still logged on the day the exception is wrongly installed.
  const provers: AdminSecondFactor[] = [new ClerkSecondFactor()];

  // Access second, and the order between the two real provers is a cost
  // decision rather than a security one: either may satisfy the rule, and Clerk
  // answers from a claim already on the session while this one may fetch a key
  // set over the network on a cold start. Asking the free one first means the
  // network call happens only when it is actually needed.
  if (options.access !== undefined) {
    provers.push(
      new CloudflareAccessSecondFactor({
        teamDomain: options.access.teamDomain,
        audience: options.access.audience,
        logger: options.logger,
      }),
    );
  }

  // Appended, never inserted. It must be last, and it must not exist at all
  // when the flag is off — an environment that cannot set the flag cannot
  // construct the adapter.
  if (options.allowWithoutSecondFactor) {
    provers.push(new DevelopmentSecondFactor(options.logger));
  }

  return new SecondFactorChain({ provers, logger: options.logger });
}
