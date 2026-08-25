import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ME_SIGN_INS_PATH, signInsResponseSchema } from '@platform/contracts';
import { Time } from '@platform/core';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  createCatalogueFakes,
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import type { ProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from './testing/fakes.js';
import type { IdentityFakes } from './testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { bookingModuleFakes } from '../booking/testing/fakes.js';

/**
 * The sign-in history route against the real application.
 *
 * The service tests prove the recording; this proves the route is guarded, that
 * a suspended account can still reach it, and — the one that matters most —
 * that nobody can read anybody else's.
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

const ACTIVITY = {
  ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
  browserName: 'Edge',
  browserVersion: '150.0.0.0',
  deviceType: 'Windows',
  isMobile: false,
};

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  profiles = createProfileFakes(audit);
  identity.sessionVerifier.accept('alice-token', ALICE).accept('bob-token', BOB);

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
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
          accountData: identity.accountData,
          accountAdmin: identity.accountAdmin,
          roleApprovals: identity.roleApprovals,
          secondFactor: identity.secondFactor,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: createCatalogueFakes().service,
        featureFlags: createFeatureFlagFakes().service,
        ...listingModuleFakes(),
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

function get(token: string | null) {
  return app.inject({
    method: 'GET',
    url: ME_SIGN_INS_PATH,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

/** Sign in, then record a session event against whichever account that made. */
async function signInAndRecord(
  token: string,
  session: typeof ALICE,
  clerkSessionId: string,
) {
  const response = await get(token);
  const user = identity.users
    .all()
    .find((row) => row.clerkUserId === session.clerkUserId);
  if (user === undefined) throw new Error('account was not provisioned');

  await identity.authenticationEvents.record({
    userId: user.id,
    clerkSessionId,
    event: 'started',
    occurredAt: Time.fromIsoUtc('2026-07-30T10:53:19.422Z'),
    activity: ACTIVITY,
  });

  return { user, response };
}

describe('GET /me/sign-ins', () => {
  it('refuses a request with no token', async () => {
    expect((await get(null)).statusCode).toBe(401);
  });

  it('serves the caller their own sign-ins', async () => {
    await signInAndRecord('alice-token', ALICE, 'sess_alice_1');

    const response = await get('alice-token');
    expect(response.statusCode).toBe(200);

    const body = signInsResponseSchema.parse(response.json());
    expect(body.entries).toEqual([
      expect.objectContaining({
        event: 'started',
        sessionId: 'sess_alice_1',
        occurredAt: '2026-07-30T10:53:19.422Z',
        browserName: 'Edge',
        deviceType: 'Windows',
        isMobile: false,
        ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
      }),
    ]);
  });

  it('never serves one account the sign-ins of another', async () => {
    // BRD §14's Phase 1 exit gate asks for automated tests proving users cannot
    // read each other's private data. A sign-in list is a map of where somebody
    // has been, so this is the sharpest form of that requirement.
    await signInAndRecord('alice-token', ALICE, 'sess_alice_1');
    await get('bob-token');

    const body = signInsResponseSchema.parse((await get('bob-token')).json());
    expect(body.entries).toEqual([]);
  });

  it('takes the account from the session, not from anything the caller sends', async () => {
    // There is no id in the path and no way to supply one. Asserted rather than
    // assumed, because "may this person read that" must not be a question
    // somebody has to remember to ask.
    await signInAndRecord('alice-token', ALICE, 'sess_alice_1');

    const response = await app.inject({
      method: 'GET',
      url: `${ME_SIGN_INS_PATH}?userId=whoever`,
      headers: { authorization: 'Bearer bob-token' },
    });

    expect(signInsResponseSchema.parse(response.json()).entries).toEqual([]);
  });

  it('answers a suspended account', async () => {
    // ADR 0024: UK GDPR access rights do not lapse on suspension, and somebody
    // suspended after a takeover needs this page precisely then.
    const { user } = await signInAndRecord('alice-token', ALICE, 'sess_alice_1');
    identity.users.seed({
      ...user,
      suspendedAt: Time.nowUtc(),
      suspensionReason: 'Investigating a report',
    });

    const response = await get('alice-token');
    expect(response.statusCode).toBe(200);
    expect(signInsResponseSchema.parse(response.json()).entries).toHaveLength(1);
  });

  it('can fail: the route is refused when it does not opt in to suspension', async () => {
    // Proves the assertion above is testing the decorator rather than the
    // absence of a suspension. A route without @AllowsSuspended answers 403 for
    // the same account in the same state — `/me/profile` is one such.
    const { user } = await signInAndRecord('alice-token', ALICE, 'sess_alice_1');
    identity.users.seed({
      ...user,
      suspendedAt: Time.nowUtc(),
      suspensionReason: 'Investigating a report',
    });

    const refused = await app.inject({
      method: 'PUT',
      url: '/me/profile',
      headers: { authorization: 'Bearer alice-token' },
      payload: { displayName: 'Alice' },
    });

    expect(refused.statusCode).toBe(403);
  });

  it('serves an empty list rather than 404 for an account with no sign-ins', async () => {
    // "Nothing recorded" and "no such thing" must not look the same: the page
    // words the empty case carefully, and a 404 would send it down the error
    // branch that says the history could not be loaded.
    const response = await get('alice-token');

    expect(response.statusCode).toBe(200);
    expect(signInsResponseSchema.parse(response.json()).entries).toEqual([]);
  });

  it('records no audit entry for reading your own history', async () => {
    // Deliberately unlike the export. Nothing leaves the platform and the
    // reader is the subject, so auditing it would add a row every time somebody
    // checked their own trail and bury the entries that matter.
    await signInAndRecord('alice-token', ALICE, 'sess_alice_1');
    const before = audit.log.entries().length;

    await get('alice-token');

    expect(audit.log.entries()).toHaveLength(before);
  });
});
