import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ME_PROFILE_PATH,
  myProfileResponseSchema,
  publicProfilePath,
  publicProfileSchema,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { ProfilesService } from './profiles.service.js';
import { InMemoryAccountLookup, InMemoryProfileStore } from './testing/fakes.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  createCatalogueFakes,
  listingModuleFakes,
} from '../catalogue/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { bookingModuleFakes } from '../booking/testing/fakes.js';

/**
 * Boots the real application — real routing, real guard, real exception filter
 * — against fakes.
 *
 * **This file is where BRD §14's Phase 1 exit gate is answered:** "automated
 * tests prove users cannot read or modify another user's private data". The
 * service tests prove the projections in isolation; only this proves the guard
 * is actually attached to the private controller and absent from the public
 * one. A `canActivate` that rejects perfectly but was never wired lets every
 * request through, and no unit test can see it.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const ALICE_PROFILE = {
  displayName: 'Alice A.',
  phone: '07700 900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: 'Flat 3',
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
};

let app: NestFastifyApplication;
let identity: IdentityFakes;
let profiles: InMemoryProfileStore;
let accounts: InMemoryAccountLookup;
let audit: AuditFakes;

/** Ids are minted by the identity fake on first authenticated request. */
async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return (response.json() as { id: string }).id;
}

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  identity.sessionVerifier.accept('alice-token', ALICE).accept('bob-token', BOB);

  profiles = new InMemoryProfileStore();
  accounts = new InMemoryAccountLookup();
  audit = createAuditFakes();

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
        profiles: new ProfilesService(profiles, accounts, audit.service),
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

const getMine = (token?: string) =>
  app.inject({
    method: 'GET',
    url: ME_PROFILE_PATH,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

const putMine = (token: string | undefined, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: ME_PROFILE_PATH,
    payload: payload as never,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

const getPublic = (userId: string) =>
  app.inject({ method: 'GET', url: publicProfilePath(userId) });

describe('GET /me/profile', () => {
  it('rejects an unauthenticated request', async () => {
    // The guard is attached. Everything else in this file assumes it.
    expect((await getMine()).statusCode).toBe(401);
  });

  it('rejects a token it cannot verify', async () => {
    expect((await getMine('forged-token')).statusCode).toBe(401);
  });

  it('answers null before the first save', async () => {
    const response = await getMine('alice-token');

    expect(response.statusCode).toBe(200);
    // Parsed against the shared contract rather than merely inspected, so a
    // drift from what the web app expects fails on this side first.
    expect(myProfileResponseSchema.parse(response.json())).toEqual({ profile: null });
  });
});

describe('PUT /me/profile', () => {
  it('rejects an unauthenticated write', async () => {
    expect((await putMine(undefined, ALICE_PROFILE)).statusCode).toBe(401);
    expect(profiles.all()).toHaveLength(0);
  });

  it('saves and reads back, normalising as it goes', async () => {
    const saved = await putMine('alice-token', ALICE_PROFILE);
    expect(saved.statusCode).toBe(200);

    const response = await getMine('alice-token');
    const { profile } = myProfileResponseSchema.parse(response.json());

    expect(profile).toMatchObject({
      displayName: 'Alice A.',
      // Normalised at the contract boundary, so every layer below sees one form.
      phone: '+447700900123',
      address: { postcode: 'BS7 8AA', line2: 'Flat 3' },
    });
  });

  it('answers 400 with the offending fields named', async () => {
    const response = await putMine('alice-token', {
      displayName: 'x',
      phone: 'nope',
    });

    expect(response.statusCode).toBe(400);
    // The messages describe the caller's own submission, which they already
    // have — withholding them makes a form that cannot say which box is wrong.
    const body = JSON.stringify(response.json());
    expect(body).toContain('displayName');
    expect(body).toContain('phone');
  });

  it('rejects a postcode that is not a UK postcode', async () => {
    const response = await putMine('alice-token', {
      ...ALICE_PROFILE,
      address: { ...ALICE_PROFILE.address, postcode: '90210' },
    });

    expect(response.statusCode).toBe(400);
    expect(profiles.all()).toHaveLength(0);
  });
});

describe('the ownership boundary — BRD §14 Phase 1 exit gate', () => {
  it('writes only the caller’s row, whatever the body claims', async () => {
    const aliceId = await idOf('alice-token');
    const bobId = await idOf('bob-token');

    // A body naming somebody else. The route takes its id from the verified
    // session, so these fields are simply not read — and because there is no
    // parameter for them, there is no check that could later be forgotten.
    await putMine('bob-token', {
      ...ALICE_PROFILE,
      displayName: 'Bob B.',
      userId: aliceId,
      id: aliceId,
    });

    const written = profiles.all();
    expect(written).toHaveLength(1);
    expect(written[0]?.userId).toBe(bobId);
    expect(written[0]?.userId).not.toBe(aliceId);
  });

  it('does not let one user read another’s private profile', async () => {
    await putMine('alice-token', ALICE_PROFILE);

    // Bob asking the only route that returns contact data gets his own, which
    // is empty — there is no URL through which he could ask for Alice's.
    const response = await getMine('bob-token');
    expect(myProfileResponseSchema.parse(response.json())).toEqual({ profile: null });
  });

  it('never exposes contact data through the public route', async () => {
    const aliceId = await idOf('alice-token');
    accounts.add(aliceId);
    await putMine('alice-token', ALICE_PROFILE);

    const response = await getPublic(aliceId);
    expect(response.statusCode).toBe(200);

    // Asserted against the raw body, not the parsed object: the parser strips
    // unknown keys, so parsing first would hide a leak rather than catch it.
    const raw = response.body;
    expect(raw).not.toContain('900123');
    expect(raw).not.toContain('447700');
    expect(raw).not.toContain('Acacia');
    expect(raw).not.toContain('Flat 3');
    expect(raw).not.toContain('alice@example.com');
    // The inward code, which is the difference between a district and a door.
    expect(raw).not.toContain('8AA');

    expect(publicProfileSchema.parse(response.json())).toEqual({
      id: aliceId,
      displayName: 'Alice A.',
      outwardCode: 'BS7',
      town: 'Bristol',
      memberSince: '2026-07',
    });
  });
});

describe('GET /users/:userId/profile', () => {
  it('needs no session — visitors may view public profiles', async () => {
    // BRD §2 gives visitors this right, which is why the controller is
    // deliberately unguarded and deliberately separate.
    const aliceId = await idOf('alice-token');
    accounts.add(aliceId);
    await putMine('alice-token', ALICE_PROFILE);

    expect((await getPublic(aliceId)).statusCode).toBe(200);
  });

  it('answers 404 for an account with no profile yet', async () => {
    const aliceId = await idOf('alice-token');
    accounts.add(aliceId);

    expect((await getPublic(aliceId)).statusCode).toBe(404);
  });

  it('answers 404 for an id that belongs to nobody', async () => {
    expect((await getPublic('00000000-0000-4000-8000-00000000dead')).statusCode).toBe(
      404,
    );
  });

  it('answers 404 rather than 500 for an id that is not a uuid', async () => {
    // The value comes out of a URL, so it is whatever someone typed. A 500 here
    // would be an error page for what is simply a wrong address.
    expect((await getPublic('banana')).statusCode).toBe(404);
  });

  it('gives the same 404 for absent, deleted and profileless accounts', async () => {
    // Three different underlying states, one response. Distinguishing them
    // turns this route into an oracle for which user ids are real, which is the
    // first step of scraping a user base.
    const aliceId = await idOf('alice-token');
    const bobId = await idOf('bob-token');

    accounts.add(bobId);
    await putMine('bob-token', ALICE_PROFILE);
    accounts.remove(bobId); // deleted, profile row intact

    accounts.add(aliceId); // exists, never made a profile

    const statuses = await Promise.all(
      [aliceId, bobId, '00000000-0000-4000-8000-00000000dead'].map(
        async (id) => (await getPublic(id)).statusCode,
      ),
    );

    expect(statuses).toEqual([404, 404, 404]);
  });

  it('stops publishing a deleted account while the row still exists', async () => {
    const aliceId = await idOf('alice-token');
    accounts.add(aliceId);
    await putMine('alice-token', ALICE_PROFILE);
    expect((await getPublic(aliceId)).statusCode).toBe(200);

    accounts.remove(aliceId);

    expect((await getPublic(aliceId)).statusCode).toBe(404);
    // Still stored — this is a disclosure rule, not an erasure. Erasure is a
    // later, deliberate slice, and until it lands this check is the only thing
    // keeping a deleted person off the internet.
    expect(profiles.all()).toHaveLength(1);
  });
});
