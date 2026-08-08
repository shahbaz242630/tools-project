import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CLIENT_IP_HEADER,
  ME_ACTIVITY_PATH,
  ME_PROFILE_PATH,
  activityResponseSchema,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import type { ProfileFakes } from '../profiles/testing/fakes.js';
import { createAuditFakes } from './testing/fakes.js';
import {
  createCatalogueFakes,
  createListingFakes,
} from '../catalogue/testing/fakes.js';
import type { AuditFakes } from './testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';

/**
 * The activity route against the real application — real routing, real guard.
 *
 * The service tests prove the queries; this proves the guard is attached and
 * that the audit trail an action produces is actually reachable by the person
 * it belongs to and by nobody else.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let profiles: ProfileFakes;

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  profiles = createProfileFakes(audit);
  identity.sessionVerifier.accept('alice-token', ALICE).accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        // A real registry is not wanted here: these tests are about routing and
        // authorisation, and a metrics backend that collected would make two
        // suites in one process share series.
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: createCatalogueFakes().service,
        featureFlags: createFeatureFlagFakes().service,
        listings: createListingFakes().service,
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

const activity = (token?: string, ip?: string) =>
  app.inject({
    method: 'GET',
    url: ME_ACTIVITY_PATH,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(ip === undefined ? {} : { [CLIENT_IP_HEADER]: ip }),
    },
  });

const saveProfile = (token: string, ip?: string) =>
  app.inject({
    method: 'PUT',
    url: ME_PROFILE_PATH,
    headers: {
      authorization: `Bearer ${token}`,
      ...(ip === undefined ? {} : { [CLIENT_IP_HEADER]: ip }),
    },
    payload: { displayName: 'Alice A.' } as never,
  });

describe('GET /me/activity', () => {
  it('rejects an unauthenticated request', async () => {
    expect((await activity()).statusCode).toBe(401);
  });

  it('records provisioning on the very first authenticated request', async () => {
    // The first thing that ever appears in anybody's activity, and it appears
    // without the application doing anything else.
    const response = await activity('alice-token', '203.0.113.7');

    expect(response.statusCode).toBe(200);
    const { entries } = activityResponseSchema.parse(response.json());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'account.provisioned',
      targetType: 'user',
      ipAddress: '203.0.113.7',
    });
  });

  it('records the session the action happened in', async () => {
    // End to end through the real guard and the real route: the `sid` claim
    // reaches the audit row and comes back on the wire, which is what lets the
    // page name the device an action was taken from. Tested here rather than
    // only at the service, because a controller that forgot to build the actor
    // with it would pass every unit test — the exact failure ADR 0025 records
    // one layer down.
    await activity('alice-token', '203.0.113.7');

    const { entries } = activityResponseSchema.parse(
      (await activity('alice-token')).json(),
    );
    expect(entries[0]?.sessionId).toBe('sess_a');
  });

  it('records the address the web app forwarded', async () => {
    // The API cannot see a browser, so this value only exists because it was
    // forwarded. If the header stops being sent, the column silently becomes
    // null — which is why the absence is tested too, below.
    await activity('alice-token', '198.51.100.4');

    const { entries } = activityResponseSchema.parse(
      (await activity('alice-token')).json(),
    );
    expect(entries[0]?.ipAddress).toBe('198.51.100.4');
  });

  it('records no address when none was forwarded', async () => {
    await activity('alice-token');

    const { entries } = activityResponseSchema.parse(
      (await activity('alice-token')).json(),
    );
    expect(entries[0]?.ipAddress).toBeNull();
  });

  it('ignores a repeated address header rather than picking one', async () => {
    // Two values means something sits between us and the web app. Choosing
    // arbitrarily would record a guess as fact.
    await app.inject({
      method: 'GET',
      url: ME_ACTIVITY_PATH,
      headers: {
        authorization: 'Bearer alice-token',
        [CLIENT_IP_HEADER]: ['203.0.113.7', '198.51.100.4'],
      },
    });

    const { entries } = activityResponseSchema.parse(
      (await activity('alice-token')).json(),
    );
    expect(entries[0]?.ipAddress).toBeNull();
  });

  it('shows a profile save in the trail', async () => {
    await saveProfile('alice-token', '203.0.113.7');

    const { entries } = activityResponseSchema.parse(
      (await activity('alice-token')).json(),
    );

    // Newest first: the profile creation, then the provisioning that preceded it.
    expect(entries.map((entry) => entry.action)).toEqual([
      'profile.created',
      'account.provisioned',
    ]);
  });

  it('never serves the digests', async () => {
    // Asserted on the raw body rather than the parsed object — the parser
    // strips unknown keys, so parsing first would hide a leak instead of
    // catching it.
    await saveProfile('alice-token');
    const raw = (await activity('alice-token')).body;

    expect(raw).not.toContain('beforeHash');
    expect(raw).not.toContain('afterHash');
  });

  it('shows no personal data, only what happened', async () => {
    await saveProfile('alice-token');
    const raw = (await activity('alice-token')).body;

    expect(raw).not.toContain('Alice A.');
    expect(raw).not.toContain('alice@example.com');
  });
});

describe('the ownership boundary', () => {
  it('shows each person only their own trail', async () => {
    await saveProfile('alice-token');
    await saveProfile('bob-token');

    const alice = activityResponseSchema.parse((await activity('alice-token')).json());
    const bob = activityResponseSchema.parse((await activity('bob-token')).json());

    // Each has exactly their own two events, and no id appears in both.
    expect(alice.entries).toHaveLength(2);
    expect(bob.entries).toHaveLength(2);

    const aliceIds = new Set(alice.entries.map((entry) => entry.id));
    expect(bob.entries.some((entry) => aliceIds.has(entry.id))).toBe(false);
  });

  it('offers no way to ask for somebody else’s', async () => {
    // There is no id in the path and no query parameter to supply one. Reading
    // everyone's entries is an administrative capability and belongs with the
    // admin role and its own audit trail, not with a parameter.
    await saveProfile('bob-token');

    const response = await app.inject({
      method: 'GET',
      url: `${ME_ACTIVITY_PATH}?actorId=${identity.users.all()[0]?.id ?? ''}`,
      headers: { authorization: 'Bearer alice-token' },
    });

    const { entries } = activityResponseSchema.parse(response.json());
    // Alice's own provisioning only — the parameter changed nothing.
    expect(entries.every((entry) => entry.action === 'account.provisioned')).toBe(true);
    expect(entries).toHaveLength(1);
  });
});
