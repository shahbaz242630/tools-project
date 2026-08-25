/**
 * Prove a second factor from Clerk's `fva` claim.
 *
 * The claim is read and normalised where the session token is verified —
 * `secondFactorAge` in `clerk-session-verifier.ts` — so this adapter is the
 * thin part: it takes the already-validated age off the session and hands it to
 * the chain. That split is deliberate. The rule for reading a malformed claim
 * ("anything unexpected is null") belongs with the thing that knows the claim's
 * shape, and duplicating it here would give it two homes to drift between.
 *
 * It touches no SDK and performs no I/O, which is why it declares no timeout —
 * see `ClerkSessionVerifier` for the same property stated at more length.
 */

import type { AdminSecondFactor, SecondFactorEvidence } from './admin-second-factor.js';

export class ClerkSecondFactor implements AdminSecondFactor {
  readonly name = 'clerk-fva';

  /** It proves a real factor. Declared rather than omitted — see the port. */
  readonly bypassesSecondFactor = false;

  ageMinutes(evidence: SecondFactorEvidence): Promise<number | null> {
    // Already null for an absent claim, a malformed one, or `-1` meaning never
    // verified — the three cases ADR 0021 requires to be indistinguishable from
    // "not verified".
    return Promise.resolve(evidence.session.secondFactorAgeMinutes);
  }
}
