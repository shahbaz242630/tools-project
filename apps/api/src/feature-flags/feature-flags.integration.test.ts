import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ADMIN_FEATURE_FLAGS_ROUTE,
  FEATURE_FLAGS,
  ME_PATH,
  adminFeatureFlagPath,
  parseAdminFeatureFlag,
  parseAdminFeatureFlags,
} from '@platform/contracts';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import {
  InMemoryCategoryStore,
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';
import { createFeatureFlagFakes } from './testing/fakes.js';
import type { FeatureFlagFakes } from './testing/fakes.js';
import { bookingModuleFakes } from '../booking/testing/fakes.js';

/**
 * Feature flags through the real application: real routing, real guard, real
 * exception filter.
 *
 * **Authorisation is the whole reason this file exists**, and it matters more
 * here than on any other admin surface. This is the one control where a single
 * request changes what the platform does for everybody at once, and unlike a
 * role change (ADR 0023) there is no second administrator in front of it. The
 * service tests know nothing about roles or second factors; the guard enforces
 * both, and a rule enforced by a decorator is one that can be lost by deleting
 * the decorator.
 */

const FLAG = 'listing.publication';

const ADMIN = {
  clerkUserId: 'user_admin',
  sessionId: 'sess_ad',
  email: 'admin@example.com',
  secondFactorAgeMinutes: 5,
};
/** An administrator whose second factor is too old to count (ADR 0021). */
const STALE_ADMIN = {
  clerkUserId: 'user_stale',
  sessionId: 'sess_st',
  email: 'stale@example.com',
  secondFactorAgeMinutes: 60 * 24,
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const REASON = 'stopping publications while we investigate a report';

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let flags: FeatureFlagFakes;

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  const categories = new InMemoryCategoryStore();
  flags = createFeatureFlagFakes(audit);

  identity.sessionVerifier
    .accept('admin-token', ADMIN)
    .accept('stale-token', STALE_ADMIN)
    .accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter: allowAllRateLimiter,
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
          accountData: identity.accountData,
          accountAdmin: identity.accountAdmin,
          roleApprovals: identity.roleApprovals,
          secondFactor: identity.secondFactor,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(
          categories,
          audit.service,
          createRecordingLogger().logger,
        ),
        featureFlags: flags.service,
        ...listingModuleFakes(categories),
        ...bookingModuleFakes(),
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const switchPath = (key: string, reason = REASON) =>
  `${adminFeatureFlagPath(key)}?reason=${encodeURIComponent(reason)}`;

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

async function promoteAdmin(): Promise<void> {
  identity.users.promote(await idOf('admin-token'));
  identity.users.promote(await idOf('stale-token'));
}

/**
 * Only this module's entries.
 *
 * Promoting through `/me` provisions two mirror rows and audits both, so a bare
 * count would measure the harness rather than the routes. Filtering by action
 * also states what each assertion is actually about.
 */
const flagEntries = () =>
  audit.log.entries().filter((entry) => entry.action === 'feature_flag.changed');

const setFlag = (
  enabled: boolean,
  token = 'admin-token',
  key = FLAG,
  reason = REASON,
) =>
  app.inject({
    method: 'PUT',
    url: switchPath(key, reason),
    headers: auth(token),
    payload: { enabled },
  });

describe('authorisation', () => {
  it('refuses an anonymous reader', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_FEATURE_FLAGS_ROUTE,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an anonymous switch', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: switchPath(FLAG),
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(401);
    expect(flags.store.all()).toHaveLength(0);
  });

  it('refuses an ordinary signed-in user', async () => {
    // 403, not 404: the route exists and they are simply not allowed to use it.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: ADMIN_FEATURE_FLAGS_ROUTE,
          headers: auth('bob-token'),
        })
      ).statusCode,
    ).toBe(403);

    expect((await setFlag(false, 'bob-token')).statusCode).toBe(403);
    expect(flags.store.all()).toHaveLength(0);
  });

  it('refuses an administrator whose second factor is stale', async () => {
    await promoteAdmin();

    // ADR 0021. The kill switch is exactly the control somebody would want to
    // reach with a stolen session, so the second factor is not optional here.
    expect((await setFlag(false, 'stale-token')).statusCode).toBe(403);
    expect(flags.store.all()).toHaveLength(0);
  });
});

describe('reading the flags', () => {
  beforeEach(promoteAdmin);

  it('lists every declared flag at its default', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_FEATURE_FLAGS_ROUTE,
      headers: auth('admin-token'),
    });

    expect(response.statusCode).toBe(200);
    const { flags: listed } = parseAdminFeatureFlags(response.json());
    /*
     * **Every declared flag, in declaration order** — the page has to offer every
     * switch that exists. Asserted against `FEATURE_FLAGS` rather than a literal
     * list, so declaring a second one is not a test to edit (slice 5.2c, when
     * declaring one *was*).
     */
    expect(listed.map((flag) => flag.key)).toEqual(
      FEATURE_FLAGS.map((declaration) => declaration.key),
    );
    expect(listed.find((flag) => flag.key === FLAG)).toMatchObject({
      key: FLAG,
      enabled: true,
      defaultEnabled: true,
      source: 'default',
    });
  });

  it('does not audit a read', async () => {
    await app.inject({
      method: 'GET',
      url: ADMIN_FEATURE_FLAGS_ROUTE,
      headers: auth('admin-token'),
    });

    // A flag has no subject whose personal data a read discloses, so there is
    // nothing to explain to anybody. Auditing every glance at the list would
    // bury the disclosures that do matter (ADR 0021).
    expect(flagEntries()).toHaveLength(0);
  });
});

describe('switching a flag', () => {
  beforeEach(promoteAdmin);

  it('switches it and returns the new state', async () => {
    const response = await setFlag(false);

    expect(response.statusCode).toBe(200);
    expect(parseAdminFeatureFlag(response.json())).toMatchObject({
      key: FLAG,
      enabled: false,
      source: 'override',
    });
  });

  it('takes effect immediately, with no cache to wait out', async () => {
    await setFlag(false);

    const listed = parseAdminFeatureFlags(
      (
        await app.inject({
          method: 'GET',
          url: ADMIN_FEATURE_FLAGS_ROUTE,
          headers: auth('admin-token'),
        })
      ).json(),
    );
    // The administrator who just threw the switch must see it. A page showing
    // the old value is indistinguishable from a write that failed, and during an
    // incident they will throw it again.
    expect(listed.flags[0]?.enabled).toBe(false);
  });

  it('records who, what and why', async () => {
    await setFlag(false);

    const entries = flagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'feature_flag.changed',
      targetType: 'feature_flag',
      reason: REASON,
      actorId: await idOf('admin-token'),
    });
  });

  it('requires a reason', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: adminFeatureFlagPath(FLAG),
      headers: auth('admin-token'),
      payload: { enabled: false },
    });

    // §9 requires the actor, the reason, the target and the before/after. A
    // switch with no reason is the one nobody can explain afterwards.
    expect(response.statusCode).toBe(400);
    expect(flags.store.all()).toHaveLength(0);
  });

  it('refuses a body that is not a boolean', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: switchPath(FLAG),
      headers: auth('admin-token'),
      payload: { enabled: 'off' },
    });

    expect(response.statusCode).toBe(400);
    expect(flags.store.all()).toHaveLength(0);
  });

  it('answers 404 for a key this build does not declare', async () => {
    const response = await setFlag(false, 'admin-token', 'listing.invented');

    // Not 400. The request is well formed; there is simply no such flag. And
    // nothing is stored — a row for an undeclared key would be a switch on this
    // page that gates nothing.
    expect(response.statusCode).toBe(404);
    expect(flags.store.all()).toHaveLength(0);
    expect(flagEntries()).toHaveLength(0);
  });

  it('is idempotent', async () => {
    await setFlag(false);
    const again = await setFlag(false, 'admin-token', FLAG, 'confirming it is off');

    // A kill switch that errors because it was already thrown makes an incident
    // worse. One row, two audit entries.
    expect(again.statusCode).toBe(200);
    expect(flags.store.all()).toHaveLength(1);
    expect(flagEntries()).toHaveLength(2);
  });
});
