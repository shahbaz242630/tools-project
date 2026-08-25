import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it } from 'vitest';
import { MAX_SECOND_FACTOR_AGE_MINUTES } from './admin-second-factor.js';
import { composeSecondFactor } from './compose-second-factor.js';
import type { VerifiedSession } from './session-verifier.js';

const SESSION: VerifiedSession = {
  clerkUserId: 'user_abc',
  sessionId: 'sess_abc',
  email: 'someone@example.com',
  secondFactorAgeMinutes: null,
};

const evidenceWith = (secondFactorAgeMinutes: number | null) => ({
  session: { ...SESSION, secondFactorAgeMinutes },
  headers: {},
});

const compose = (allowWithoutSecondFactor: boolean) => {
  const logger = createRecordingLogger();
  return {
    chain: composeSecondFactor({ allowWithoutSecondFactor, logger: logger.logger }),
    logger,
  };
};

/**
 * These assert the composition root, not the chain.
 *
 * The chain's own tests build their own arrays, so every one of them would stay
 * green if `main.ts` installed the development exception *first* — and that
 * reordering would silently discard ADR 0030's guarantee that the rule the
 * exception replaces is evaluated and logged before the exception is consulted.
 * The ordering is a property of what the application actually builds, so it is
 * asserted against what the application actually builds.
 */
describe('composeSecondFactor', () => {
  describe('with the escape hatch off, which is every deployed environment', () => {
    it('installs the real prover and nothing else', () => {
      expect(compose(false).chain.proverNames).toEqual(['clerk-fva']);
    });

    it('does not construct the development adapter at all', () => {
      // Not merely "does not reach it" — it must not exist. An environment that
      // cannot set the flag must not be able to hold the object.
      expect(compose(false).chain.proverNames).not.toContain('development-bypass');
    });

    it('reports that it does not bypass, so no banner is raised', () => {
      expect(compose(false).chain.bypassesSecondFactor).toBe(false);
    });

    it('refuses an administrator with no second factor', async () => {
      const { chain } = compose(false);

      expect((await chain.prove(evidenceWith(null))).proof).toBeNull();
    });
  });

  describe('with the escape hatch on', () => {
    it('puts the real prover first and the exception last', () => {
      // **The assertion this file exists for.** Order, not membership.
      expect(compose(true).chain.proverNames).toEqual([
        'clerk-fva',
        'development-bypass',
      ]);
    });

    it('reports that it bypasses, so every admin page carries the banner', () => {
      expect(compose(true).chain.bypassesSecondFactor).toBe(true);
    });

    it('still lets the real prover answer first when it can', async () => {
      const { chain, logger } = compose(true);

      const decision = await chain.prove(evidenceWith(4));

      expect(decision.proof).toEqual({ ageMinutes: 4, provenBy: 'clerk-fva' });
      // The exception warns on every request it admits, so silence proves it
      // was never consulted rather than merely that it lost.
      expect(logger.at('warn')).toEqual([]);
    });

    it('admits only after the real prover has been asked and failed', async () => {
      const { chain } = compose(true);

      const decision = await chain.prove(
        evidenceWith(MAX_SECOND_FACTOR_AGE_MINUTES + 1),
      );

      expect(decision.proof).toEqual({ ageMinutes: 0, provenBy: 'development-bypass' });
      // The stale real answer is recorded, which is what makes "the rule was
      // still evaluated" checkable rather than asserted in a comment.
      expect(decision.attempts[0]).toEqual({
        ageMinutes: MAX_SECOND_FACTOR_AGE_MINUTES + 1,
        provenBy: 'clerk-fva',
      });
    });
  });
});
