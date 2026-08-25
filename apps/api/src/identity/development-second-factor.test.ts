import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it } from 'vitest';
import type { SecondFactorEvidence } from './admin-second-factor.js';
import {
  ADMIN_MFA_BYPASS_VARIABLE,
  DevelopmentSecondFactor,
} from './development-second-factor.js';
import type { VerifiedSession } from './session-verifier.js';

const SESSION: VerifiedSession = {
  clerkUserId: 'user_abc',
  sessionId: 'sess_abc',
  email: 'someone@example.com',
  secondFactorAgeMinutes: null,
};

const EVIDENCE: SecondFactorEvidence = { session: SESSION, headers: {} };

const build = () => {
  const logger = createRecordingLogger();
  return { adapter: new DevelopmentSecondFactor(logger.logger), logger };
};

describe('DevelopmentSecondFactor', () => {
  it('proves a factor that was never verified, which is the whole of what it does', async () => {
    const { adapter } = build();

    expect(await adapter.ageMinutes(EVIDENCE)).toBe(0);
  });

  it('answers zero rather than the age limit', async () => {
    const { adapter } = build();

    // "Verified just now", not "verified as long ago as is still allowed".
    // A value pinned to the limit would start refusing the day somebody
    // tightened the bound, and the failure would read as a real refusal.
    expect(await adapter.ageMinutes(EVIDENCE)).toBe(0);
  });

  it('declares that it bypasses the second factor, so the banner is raised', () => {
    const { adapter } = build();

    expect(adapter.bypassesSecondFactor).toBe(true);
  });

  describe('what it announces', () => {
    it('warns on every request it admits, not only at startup', async () => {
      const { adapter, logger } = build();

      await adapter.ageMinutes(EVIDENCE);
      await adapter.ageMinutes(EVIDENCE);

      // Two admissions, two warnings. A banner tells whoever is looking at a
      // page; this tells whoever reads the logs afterwards which requests were
      // admitted under the exception — the question asked after the fact.
      expect(logger.at('warn')).toHaveLength(2);
    });

    it('names the variable, so a log search finds the requests and not just the banner', async () => {
      const { adapter, logger } = build();

      await adapter.ageMinutes(EVIDENCE);

      expect(JSON.stringify(logger.at('warn')[0])).toContain(ADMIN_MFA_BYPASS_VARIABLE);
    });

    it('names the account the request spoke for', async () => {
      const { adapter, logger } = build();

      await adapter.ageMinutes(EVIDENCE);

      expect(logger.at('warn')[0]?.fields).toMatchObject({ clerkUserId: 'user_abc' });
    });
  });
});
