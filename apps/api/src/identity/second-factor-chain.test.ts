import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it } from 'vitest';
import { MAX_SECOND_FACTOR_AGE_MINUTES } from './admin-second-factor.js';
import type { AdminSecondFactor, SecondFactorEvidence } from './admin-second-factor.js';
import { ClerkSecondFactor } from './clerk-second-factor.js';
import { DevelopmentSecondFactor } from './development-second-factor.js';
import { SecondFactorChain } from './second-factor-chain.js';
import type { VerifiedSession } from './session-verifier.js';

const SESSION: VerifiedSession = {
  clerkUserId: 'user_abc',
  sessionId: 'sess_abc',
  email: 'someone@example.com',
  secondFactorAgeMinutes: null,
};

const EVIDENCE: SecondFactorEvidence = { session: SESSION, headers: {} };

/**
 * A prover that answers with whatever it was built with, and records that it
 * was asked. Behavioural rather than a spy on purpose — several tests here turn
 * on whether a prover was consulted *at all*, which a stub returning a value
 * cannot express.
 */
class StubProver implements AdminSecondFactor {
  asked = 0;

  constructor(
    readonly name: string,
    private readonly answer: number | null | Error,
    // Definite rather than optional: `exactOptionalPropertyTypes` makes an
    // omitted optional and an explicit `undefined` different types, and a stub
    // is not where that distinction earns its keep.
    readonly bypassesSecondFactor = false,
  ) {}

  ageMinutes(): Promise<number | null> {
    this.asked += 1;
    if (this.answer instanceof Error) return Promise.reject(this.answer);
    return Promise.resolve(this.answer);
  }
}

const chainOf = (...provers: AdminSecondFactor[]) => {
  const logger = createRecordingLogger();
  return { chain: new SecondFactorChain({ provers, logger: logger.logger }), logger };
};

describe('SecondFactorChain', () => {
  it('proves from the first prover that answers within the age bound', async () => {
    const first = new StubProver('first', 5);
    const second = new StubProver('second', 1);
    const { chain } = chainOf(first, second);

    const decision = await chain.prove(EVIDENCE);

    expect(decision.proof).toEqual({ ageMinutes: 5, provenBy: 'first' });
    // Not merely "the right answer" — the second prover must never have been
    // reached, which is what makes the escape hatch's ordering safe.
    expect(second.asked).toBe(0);
  });

  it('refuses when no prover can tell', async () => {
    const { chain } = chainOf(
      new StubProver('first', null),
      new StubProver('second', null),
    );

    const decision = await chain.prove(EVIDENCE);

    expect(decision.proof).toBeNull();
    expect(decision.attempts).toEqual([]);
  });

  it('refuses when every prover answers but all of them are stale', async () => {
    const { chain } = chainOf(
      new StubProver('first', MAX_SECOND_FACTOR_AGE_MINUTES + 1),
      new StubProver('second', MAX_SECOND_FACTOR_AGE_MINUTES * 10),
    );

    const decision = await chain.prove(EVIDENCE);

    expect(decision.proof).toBeNull();
  });

  /**
   * The bug this design exists to prevent.
   *
   * A chain that stopped at the first prover to *answer* rather than the first
   * to answer *acceptably* would take the stale Clerk claim, refuse, and lock
   * out an administrator who had just presented a security key seconds earlier.
   * Nothing about that failure would look like a bug — it is a correct-looking
   * 403 on a correctly-signed token.
   */
  it('does not let a stale prover mask a fresh one behind it', async () => {
    const stale = new StubProver('stale', MAX_SECOND_FACTOR_AGE_MINUTES + 1);
    const fresh = new StubProver('fresh', 2);
    const { chain } = chainOf(stale, fresh);

    const decision = await chain.prove(EVIDENCE);

    expect(decision.proof).toEqual({ ageMinutes: 2, provenBy: 'fresh' });
    expect(fresh.asked).toBe(1);
  });

  it('admits at exactly the age limit, and refuses one minute past it', async () => {
    const { chain: atLimit } = chainOf(
      new StubProver('p', MAX_SECOND_FACTOR_AGE_MINUTES),
    );
    const { chain: pastIt } = chainOf(
      new StubProver('p', MAX_SECOND_FACTOR_AGE_MINUTES + 1),
    );

    expect((await atLimit.prove(EVIDENCE)).proof).not.toBeNull();
    expect((await pastIt.prove(EVIDENCE)).proof).toBeNull();
  });

  it('records every prover that answered, in the order asked, for a refusal to be diagnosed', async () => {
    const { chain } = chainOf(
      new StubProver('absent', null),
      new StubProver('stale', MAX_SECOND_FACTOR_AGE_MINUTES + 1),
      new StubProver('also-stale', MAX_SECOND_FACTOR_AGE_MINUTES + 2),
    );

    const decision = await chain.prove(EVIDENCE);

    // The prover that could not tell contributes nothing; the two that answered
    // appear in order. An administrator reading this can see the difference
    // between "no claim reached us" and "your claim was too old".
    expect(decision.attempts).toEqual([
      { ageMinutes: MAX_SECOND_FACTOR_AGE_MINUTES + 1, provenBy: 'stale' },
      { ageMinutes: MAX_SECOND_FACTOR_AGE_MINUTES + 2, provenBy: 'also-stale' },
    ]);
  });

  describe('when a prover fails', () => {
    it('reads it as unproven rather than letting it become a 500', async () => {
      const { chain } = chainOf(
        new StubProver('broken', new Error('jwks unreachable')),
      );

      const decision = await chain.prove(EVIDENCE);

      expect(decision.proof).toBeNull();
    });

    it('says so in a log, because nothing else records it', async () => {
      const { chain, logger } = chainOf(
        new StubProver('broken', new Error('jwks unreachable')),
      );

      await chain.prove(EVIDENCE);

      const warned = logger.at('warn');
      expect(warned).toHaveLength(1);
      expect(warned[0]?.fields).toMatchObject({ prover: 'broken' });
    });

    it('still asks the provers behind it', async () => {
      const broken = new StubProver('broken', new Error('jwks unreachable'));
      const working = new StubProver('working', 3);
      const { chain } = chainOf(broken, working);

      const decision = await chain.prove(EVIDENCE);

      // A provider outage must degrade to "that one cannot tell", not to
      // "nobody can" — otherwise Cloudflare having a bad afternoon would lock
      // out an administrator whose Clerk factor was perfectly good.
      expect(decision.proof).toEqual({ ageMinutes: 3, provenBy: 'working' });
    });
  });

  describe('bypassesSecondFactor', () => {
    it('is false when every prover proves a real factor', () => {
      const { chain } = chainOf(new StubProver('a', 1), new StubProver('b', 2));

      expect(chain.bypassesSecondFactor).toBe(false);
    });

    it('is true when any prover admits without one, so the banner cannot be missed', () => {
      const { chain } = chainOf(
        new StubProver('a', null),
        new StubProver('hatch', 0, true),
      );

      expect(chain.bypassesSecondFactor).toBe(true);
    });
  });

  it('refuses when it has no provers at all', async () => {
    const { chain } = chainOf();

    // A chain built with nothing must refuse rather than admit. It is the
    // shape a mis-wired composition root produces, and the safe reading of
    // "nothing could prove it" is the same as everywhere else here.
    expect((await chain.prove(EVIDENCE)).proof).toBeNull();
  });

  describe('an age that makes no sense', () => {
    // `age <= maximum` is true for every negative number, so the naive
    // comparison admits an adapter that is *more* wrong rather than less —
    // a clock skew subtracting two timestamps the wrong way round would
    // satisfy the strongest control in the system.
    it.each([
      ['negative', -1],
      ['hugely negative', -100_000],
      ['negative infinity', Number.NEGATIVE_INFINITY],
      ['not a number', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('refuses an age that is %s', async (_label, age) => {
      const { chain } = chainOf(new StubProver('odd', age));

      expect((await chain.prove(EVIDENCE)).proof).toBeNull();
    });

    it('does not record it as an attempt, because it is not one', async () => {
      const { chain } = chainOf(new StubProver('odd', -5));

      // An attempt is shown to an administrator diagnosing a lockout. "Your
      // factor was verified minus five minutes ago" is noise, not a diagnosis.
      expect((await chain.prove(EVIDENCE)).attempts).toEqual([]);
    });

    it('says so, and keeps asking the provers behind it', async () => {
      const { chain, logger } = chainOf(
        new StubProver('odd', -5),
        new StubProver('sane', 4),
      );

      const decision = await chain.prove(EVIDENCE);

      expect(decision.proof).toEqual({ ageMinutes: 4, provenBy: 'sane' });
      expect(logger.at('warn')[0]?.fields).toMatchObject({ prover: 'odd' });
    });
  });

  /**
   * ADR 0030's ordering guarantee, pinned with the real classes rather than
   * stubs — the composition `main.ts` actually builds.
   *
   * The escape hatch's safety property is that the rule it replaces is
   * evaluated *first*, so that on the day the flag is wrongly set nothing has
   * gone unexercised. A stub chain can demonstrate short-circuiting; only the
   * real adapters demonstrate that this particular pair is ordered correctly.
   */
  describe('the development exception, in the order main.ts installs it', () => {
    const realChain = () => {
      const logger = createRecordingLogger();
      return {
        chain: new SecondFactorChain({
          provers: [
            new ClerkSecondFactor(),
            new DevelopmentSecondFactor(logger.logger),
          ],
          logger: logger.logger,
        }),
        logger,
      };
    };

    it('is never consulted when the real factor is fresh', async () => {
      const { chain, logger } = realChain();

      const decision = await chain.prove({
        session: { ...SESSION, secondFactorAgeMinutes: 3 },
        headers: {},
      });

      expect(decision.proof).toEqual({ ageMinutes: 3, provenBy: 'clerk-fva' });
      // The exception announces itself on every request it admits, so silence
      // here is proof it was never reached — not merely that it lost.
      expect(logger.at('warn')).toEqual([]);
    });

    it('is not consulted when the real factor is fresh, even at the limit', async () => {
      const { chain, logger } = realChain();

      await chain.prove({
        session: { ...SESSION, secondFactorAgeMinutes: MAX_SECOND_FACTOR_AGE_MINUTES },
        headers: {},
      });

      expect(logger.at('warn')).toEqual([]);
    });

    it('admits once the real factor is absent, and says so', async () => {
      const { chain, logger } = realChain();

      const decision = await chain.prove(EVIDENCE);

      expect(decision.proof).toEqual({ ageMinutes: 0, provenBy: 'development-bypass' });
      expect(logger.at('warn')).toHaveLength(1);
    });

    it('admits once the real factor is stale, having asked it first', async () => {
      const { chain } = realChain();

      const decision = await chain.prove({
        session: {
          ...SESSION,
          secondFactorAgeMinutes: MAX_SECOND_FACTOR_AGE_MINUTES + 1,
        },
        headers: {},
      });

      expect(decision.proof).toEqual({ ageMinutes: 0, provenBy: 'development-bypass' });
      // The real prover's stale answer is still recorded, which is what makes
      // "the rule was evaluated" checkable rather than merely asserted.
      expect(decision.attempts[0]).toEqual({
        ageMinutes: MAX_SECOND_FACTOR_AGE_MINUTES + 1,
        provenBy: 'clerk-fva',
      });
    });
  });
});
