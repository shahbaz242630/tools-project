import { describe, expect, it } from 'vitest';
import type { SecondFactorEvidence } from './admin-second-factor.js';
import { ClerkSecondFactor } from './clerk-second-factor.js';
import type { VerifiedSession } from './session-verifier.js';

const sessionWith = (secondFactorAgeMinutes: number | null): VerifiedSession => ({
  clerkUserId: 'user_abc',
  sessionId: 'sess_abc',
  email: 'someone@example.com',
  secondFactorAgeMinutes,
});

const evidenceWith = (age: number | null): SecondFactorEvidence => ({
  session: sessionWith(age),
  headers: {},
});

describe('ClerkSecondFactor', () => {
  it('proves the age the session carries', async () => {
    expect(await new ClerkSecondFactor().ageMinutes(evidenceWith(7))).toBe(7);
  });

  it('proves nothing when the session carries no factor', async () => {
    // Null reaches here for three different reasons — the claim was absent, it
    // was malformed, or it was `-1` for never verified — and ADR 0021 requires
    // all three to be indistinguishable from "not verified". The rule that
    // makes them null lives in `secondFactorAge`, deliberately not duplicated
    // here where it would have a second home to drift from.
    expect(await new ClerkSecondFactor().ageMinutes(evidenceWith(null))).toBeNull();
  });

  it('proves a factor verified this instant', async () => {
    // Zero must not be read as absent. It is the one value where a truthiness
    // check instead of a null check would refuse a valid administrator.
    expect(await new ClerkSecondFactor().ageMinutes(evidenceWith(0))).toBe(0);
  });

  it('does not judge staleness, which is the chain’s to decide', async () => {
    // It reports an age far past any bound rather than nulling it. The chain
    // needs the number to record the attempt, so an administrator can be told
    // their factor was *old* rather than *missing*.
    expect(await new ClerkSecondFactor().ageMinutes(evidenceWith(100_000))).toBe(
      100_000,
    );
  });
});
