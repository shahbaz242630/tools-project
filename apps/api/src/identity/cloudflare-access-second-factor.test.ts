import { ACCESS_ASSERTION_HEADER } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it, vi } from 'vitest';
import type { SecondFactorEvidence } from './admin-second-factor.js';
import { CloudflareAccessSecondFactor } from './cloudflare-access-second-factor.js';
import type { AccessTokenVerifier } from './cloudflare-access-second-factor.js';
import type { VerifiedSession } from './session-verifier.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');

const SESSION: VerifiedSession = {
  clerkUserId: 'user_abc',
  sessionId: 'sess_abc',
  email: 'someone@example.com',
  secondFactorAgeMinutes: null,
};

/**
 * A human assertion, shaped from a payload read off the live App Launcher
 * rather than from the documentation — `common_name` really is `''` for a
 * person rather than absent, which is why the adapter checks both.
 */
const HUMAN = {
  aud: ['a'.repeat(64)],
  email: 'someone@example.com',
  sub: '3e9116097974f3e51e2d0d605a0c9a0e',
  common_name: '',
  iat: Math.floor(NOW.getTime() / 1000),
};

const evidenceWith = (header: string | string[] | undefined): SecondFactorEvidence => ({
  session: SESSION,
  headers: header === undefined ? {} : { [ACCESS_ASSERTION_HEADER]: header },
});

const build = (verify: AccessTokenVerifier) => {
  const logger = createRecordingLogger();
  return {
    adapter: new CloudflareAccessSecondFactor({
      teamDomain: 'https://spring-river-c250.cloudflareaccess.com',
      audience: 'a'.repeat(64),
      logger: logger.logger,
      verify,
      now: () => NOW,
    }),
    logger,
  };
};

const accepting =
  (claims: Record<string, unknown>): AccessTokenVerifier =>
  () =>
    Promise.resolve(claims);

const rejecting =
  (error: Error): AccessTokenVerifier =>
  () =>
    Promise.reject(error);

describe('CloudflareAccessSecondFactor', () => {
  it('proves a factor from a verified assertion', async () => {
    const { adapter } = build(accepting(HUMAN));

    expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBe(0);
  });

  it('reports how long ago the assertion was issued', async () => {
    const { adapter } = build(
      accepting({ ...HUMAN, iat: Math.floor(NOW.getTime() / 1000) - 45 * 60 }),
    );

    expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBe(45);
  });

  it('does not judge staleness, which is the chain’s to decide', async () => {
    // Far past any bound. The chain needs the number to record the attempt, so
    // an administrator can be told their session was old rather than absent.
    const { adapter } = build(
      accepting({ ...HUMAN, iat: Math.floor(NOW.getTime() / 1000) - 100 * 3600 }),
    );

    expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBe(6000);
  });

  it('declares that it does not bypass the second factor', () => {
    const { adapter } = build(accepting(HUMAN));

    expect(adapter.bypassesSecondFactor).toBe(false);
  });

  describe('the header', () => {
    it('proves nothing when absent, which is every local request', async () => {
      const { adapter } = build(accepting(HUMAN));

      expect(await adapter.ageMinutes(evidenceWith(undefined))).toBeNull();
    });

    it('proves nothing when empty', async () => {
      const { adapter } = build(accepting(HUMAN));

      expect(await adapter.ageMinutes(evidenceWith('   '))).toBeNull();
    });

    it('refuses a repeated header rather than picking one', async () => {
      // Fastify joins a repeated header into one comma-separated *string*, so
      // this arrives past any `typeof` check. Two values means something sits
      // between us and the web app, and choosing one would be guessing.
      const { adapter } = build(accepting(HUMAN));

      expect(await adapter.ageMinutes(evidenceWith('a.b.c,d.e.f'))).toBeNull();
    });

    it('refuses an array-valued header', async () => {
      const { adapter } = build(accepting(HUMAN));

      expect(await adapter.ageMinutes(evidenceWith(['a.b.c', 'd.e.f']))).toBeNull();
    });

    it('does not call the verifier for a header it has already refused', async () => {
      const verify = vi.fn(accepting(HUMAN));
      const { adapter } = build(verify);

      await adapter.ageMinutes(evidenceWith('a.b.c,d.e.f'));

      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe('when verification fails', () => {
    it('proves nothing rather than throwing', async () => {
      // A forged token, an expired one, a wrong audience and a Cloudflare
      // outage all land here and all mean the same thing to the caller.
      const { adapter } = build(rejecting(new Error('signature verification failed')));

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBeNull();
    });

    it('says why in a log, because the caller is told nothing', async () => {
      const { adapter, logger } = build(rejecting(new Error('JWKS timeout')));

      await adapter.ageMinutes(evidenceWith('a.b.c'));

      // The cause itself, not its rendering. A `JSON.stringify` of an `Error`
      // is `{}` — asserting on the text would have passed only because the
      // recording logger keeps the object, and would say nothing about whether
      // the reason survives.
      const fields = logger.at('warn')[0]?.fields as { error?: Error };
      expect(logger.at('warn')).toHaveLength(1);
      expect(fields.error?.message).toBe('JWKS timeout');
    });
  });

  /**
   * **The refusal that must not be wrong.**
   *
   * Access mints assertions for machine callers too, signed by the same account
   * keys and carrying the same audience — so signature and audience alone do
   * not tell a person from a service token. A service token satisfying an
   * administrator's second factor would be a credential with no human behind it
   * opening the admin surface.
   */
  describe('service tokens', () => {
    const SERVICE = {
      aud: ['a'.repeat(64)],
      common_name: 'e367826f93b8d71185e03fe518aff3b4.access',
      sub: '',
      iat: Math.floor(NOW.getTime() / 1000),
    };

    it('refuses a documented service-token payload', async () => {
      const { adapter } = build(accepting(SERVICE));

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBeNull();
    });

    it.each([
      [
        'a common name beside a full human identity',
        { ...HUMAN, common_name: 'x.access' },
      ],
      ['an empty subject', { ...HUMAN, sub: '' }],
      ['a missing subject', { ...HUMAN, sub: undefined }],
      ['an empty email', { ...HUMAN, email: '' }],
      ['a missing email', { ...HUMAN, email: undefined }],
      ['a non-string email', { ...HUMAN, email: 42 }],
    ])('refuses %s', async (_label, claims) => {
      // Each discriminator checked independently. A future Cloudflare change to
      // any single field must not silently admit a machine.
      const { adapter } = build(accepting(claims));

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBeNull();
    });

    it('accepts the empty common name a real person carries', async () => {
      // Read off the live App Launcher: a human identity has `common_name: ''`
      // rather than no such field. Refusing on presence alone would have
      // refused every administrator.
      const { adapter } = build(accepting({ ...HUMAN, common_name: '' }));

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBe(0);
    });

    it('names which service token was refused, and no email', async () => {
      const { adapter, logger } = build(accepting(SERVICE));

      await adapter.ageMinutes(evidenceWith('a.b.c'));

      const warned = logger.at('warn')[0];
      expect(warned?.fields).toMatchObject({ commonName: SERVICE.common_name });
      expect(JSON.stringify(warned)).not.toContain('@example.com');
    });
  });

  describe('the issued-at claim', () => {
    it.each([
      ['absent', undefined],
      ['a string', '1756123200'],
      ['not a number', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('proves nothing when it is %s', async (_label, iat) => {
      const { adapter } = build(accepting({ ...HUMAN, iat }));

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBeNull();
    });

    it('proves nothing for a token issued in the future', async () => {
      // The chain refuses a negative age anyway, but "we cannot tell" is the
      // honest answer to a clock that disagrees with ours, and it is the one
      // that reads correctly in a log.
      const { adapter } = build(
        accepting({ ...HUMAN, iat: Math.floor(NOW.getTime() / 1000) + 600 }),
      );

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBeNull();
    });

    it('rounds down rather than up', async () => {
      // 119 seconds is one minute old, not two. Rounding up would let a bound
      // expire a minute early, which is a refusal nobody could explain.
      const { adapter } = build(
        accepting({ ...HUMAN, iat: Math.floor(NOW.getTime() / 1000) - 119 }),
      );

      expect(await adapter.ageMinutes(evidenceWith('a.b.c'))).toBe(1);
    });
  });
});
