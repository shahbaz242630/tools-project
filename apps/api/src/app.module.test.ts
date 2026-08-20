import { allowAllRateLimiter } from './rate-limiting/testing/fakes.js';
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
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from './feature-flags/testing/fakes.js';
import { bookingModuleFakes } from './booking/testing/fakes.js';

async function resolveTimeout(readinessTimeoutMs?: number): Promise<number> {
  const { sessionVerifier, service, accountData, accountAdmin, roleApprovals } =
    createIdentityFakes();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter: allowAllRateLimiter,
        // A real registry is not wanted here: these tests are about routing and
        // authorisation, and a metrics backend that collected would make two
        // suites in one process share series.
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier,
          service,
          accountData,
          accountAdmin,
          roleApprovals,
        },
        profiles: createProfileFakes().service,
        audit: createAuditFakes().service,
        catalogue: createCatalogueFakes().service,
        featureFlags: createFeatureFlagFakes().service,
        listings: createListingFakes().service,
        ...bookingModuleFakes(),
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
