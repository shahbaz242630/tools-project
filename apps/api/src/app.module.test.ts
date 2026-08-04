import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  READINESS_TIMEOUT_MS,
} from './health/readiness.service.js';
import { createRecordingLogger } from '@platform/observability/testing';
import { createIdentityFakes } from './identity/testing/fakes.js';
import { createAuditFakes } from './audit/testing/fakes.js';
import { createCatalogueFakes, createListingFakes } from './catalogue/testing/fakes.js';
import { createProfileFakes } from './profiles/testing/fakes.js';

async function resolveTimeout(readinessTimeoutMs?: number): Promise<number> {
  const { sessionVerifier, service } = createIdentityFakes();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        checks: [],
        logger: createRecordingLogger().logger,
        identity: { sessionVerifier, service },
        profiles: createProfileFakes().service,
        audit: createAuditFakes().service,
        catalogue: createCatalogueFakes().service,
        listings: createListingFakes().service,
        ...(readinessTimeoutMs !== undefined ? { readinessTimeoutMs } : {}),
      }),
    ],
  }).compile();

  return moduleRef.get<number>(READINESS_TIMEOUT_MS);
}

describe('AppModule', () => {
  it('falls back to the default readiness timeout', async () => {
    // Without this the probe would inherit `undefined`, and `setTimeout` with
    // an undefined delay fires immediately — every dependency would report a
    // timeout regardless of whether it was reachable.
    expect(await resolveTimeout()).toBe(DEFAULT_READINESS_TIMEOUT_MS);
  });

  it('honours an explicit readiness timeout', async () => {
    expect(await resolveTimeout(50)).toBe(50);
  });
});
