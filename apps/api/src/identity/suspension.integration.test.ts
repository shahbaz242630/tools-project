import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ADMIN_APPROVALS_PATH,
  ME_ACTIVITY_PATH,
  ME_DELETION_PATH,
  ME_EXPORT_PATH,
  ME_PATH,
  ME_PROFILE_PATH,
  publicProfilePath,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  createCatalogueFakes,
  createListingFakes,
} from '../catalogue/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { InMemoryProfileStore } from '../profiles/testing/fakes.js';
import { IdentityService } from './identity.service.js';
import { AccountErasure } from './account-erasure.js';
import { AccountDataService } from './account-data.service.js';
import { AccountAdminService } from './account-admin.service.js';
import { RoleApprovalService } from './role-approval.service.js';
import {
  FakeSessionVerifier,
  InMemoryAdminApprovalStore,
  InMemoryUserDirectory,
  InMemoryWebhookLedger,
} from './testing/fakes.js';
import { InMemoryAuthenticationEvents } from './testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { createBookingFakes } from '../booking/testing/fakes.js';

/**
 * A suspended account against the real application.
 *
 * The rule this file exists to pin is **default-deny with a named allowlist**:
 * a suspended person keeps the routes that carry data-protection rights and
 * loses everything else. Both halves matter, and the second is the one a future
 * route will get wrong — which is why the guard denies unless a route opts in,
 * rather than the other way round.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
  secondFactorAgeMinutes: 5,
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const PROFILE = {
  displayName: 'Alice A.',
  phone: '07700 900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: null,
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
};

const REASON = 'suspected fraud, ticket 4821';

let app: NestFastifyApplication;
let audit: AuditFakes;
let users: InMemoryUserDirectory;

beforeEach(async () => {
  audit = createAuditFakes();
  users = new InMemoryUserDirectory();
  const approvals = new InMemoryAdminApprovalStore();

  const sessionVerifier = new FakeSessionVerifier()
    .accept('alice-token', ALICE)
    .accept('bob-token', BOB);

  // The profiles module's `AccountLookup`, answered by the **real** identity
  // service exactly as main.ts wires it. Deliberately not the in-memory lookup:
  // suspension reaches the public profile *through* this port, so a fake here
  // would let the disclosure test pass while the mechanism did nothing.
  const profiles: ProfilesService = new ProfilesService(
    new InMemoryProfileStore(),
    {
      findActive: async (userId) => {
        const user = await identity.findActiveById(userId);
        return user === null ? null : { id: user.id, createdAt: user.createdAt };
      },
    },
    audit.service,
  );
  const authenticationEvents = new InMemoryAuthenticationEvents();
  const erasure = new AccountErasure(
    users,
    audit.service,
    { erase: (actor) => profiles.eraseFor(actor) },
    authenticationEvents,
  );

  const identity: IdentityService = new IdentityService(
    users,
    new InMemoryWebhookLedger(),
    audit.service,
    authenticationEvents,
    erasure,
    createRecordingLogger().logger,
  );

  const accountData = new AccountDataService(
    users,
    audit.service,
    { exportFor: (userId: string) => profiles.exportFor(userId) },
    // Catalogue's section, stubbed empty — this file is about what suspension
    // refuses, and it creates no listings.
    { exportFor: () => Promise.resolve({ listings: [], truncated: false }) },
    authenticationEvents,
    erasure,
  );

  const accountAdmin = new AccountAdminService(users, audit.service, {
    summaryFor: (userId: string) => profiles.adminSummaryFor(userId),
  });

  const roleApprovals = new RoleApprovalService(users, audit.service, approvals);

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
          sessionVerifier,
          service: identity,
          accountData,
          accountAdmin,
          roleApprovals,
        },
        profiles,
        audit: audit.service,
        catalogue: createCatalogueFakes().service,
        featureFlags: createFeatureFlagFakes().service,
        listings: createListingFakes().service,
        availability: createBookingFakes().service,
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

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

/** Provision both accounts, then suspend Bob. Returns their ids. */
async function suspendBob(): Promise<{ alice: string; bob: string }> {
  const alice = await idOf('alice-token');
  const bob = await idOf('bob-token');
  users.promote(alice);
  users.suspend(bob, alice, REASON);
  return { alice, bob };
}

describe('what a suspended account keeps', () => {
  // UK GDPR access and erasure rights do not lapse because somebody was
  // suspended, and an account that cannot authenticate cannot exercise them.
  it.each([
    ['their own account', 'GET', ME_PATH],
    ['their own profile', 'GET', ME_PROFILE_PATH],
    ['their own activity', 'GET', ME_ACTIVITY_PATH],
    ['a copy of their data', 'GET', ME_EXPORT_PATH],
  ])('can still read %s', async (_label, method, url) => {
    await suspendBob();

    const response = await app.inject({
      method: method as 'GET',
      url,
      headers: auth('bob-token'),
    });

    expect(response.statusCode).toBe(200);
  });

  it('can still delete the account', async () => {
    // The most important one. Erasure is a right, not a privilege, and a
    // suspended person unable to exercise it is a data-protection problem
    // rather than a security feature.
    await suspendBob();

    const response = await app.inject({
      method: 'POST',
      url: ME_DELETION_PATH,
      headers: auth('bob-token'),
    });

    expect(response.statusCode).toBe(200);
  });

  it('can read the reason on their own activity page', async () => {
    // Where somebody actually finds out what happened and why.
    const { alice, bob } = await suspendBob();
    await audit.service.record({
      actor: { userId: alice, ipAddress: null, sessionId: null },
      action: 'account.suspended',
      targetType: 'user',
      targetId: bob,
      reason: REASON,
    });

    const response = await app.inject({
      method: 'GET',
      url: ME_ACTIVITY_PATH,
      headers: auth('bob-token'),
    });

    expect(response.body).toContain(REASON);
  });
});

describe('what a suspended account loses', () => {
  it('cannot change their profile', async () => {
    // The line the allowlist draws: see what we hold, take a copy, delete it —
    // but do not change what other people would see.
    await suspendBob();

    const response = await app.inject({
      method: 'PUT',
      url: ME_PROFILE_PATH,
      headers: auth('bob-token'),
      payload: PROFILE as never,
    });

    expect(response.statusCode).toBe(403);
  });

  it('is refused with 403 rather than 401', async () => {
    // 401 would tell somebody to sign in again, which cannot help and sends
    // them round a loop that does not end. A *deleted* account gets 401,
    // because there the session genuinely is dead.
    await suspendBob();

    const response = await app.inject({
      method: 'PUT',
      url: ME_PROFILE_PATH,
      headers: auth('bob-token'),
      payload: PROFILE as never,
    });

    expect(response.statusCode).not.toBe(401);
  });

  it('disappears from public profiles', async () => {
    // Nothing is removed by hand here. The public route asks identity whether
    // the account is active, and suspension is what changes that answer — so
    // this passes only if the mechanism works.
    const alice = await idOf('alice-token');
    const bob = await idOf('bob-token');

    await app.inject({
      method: 'PUT',
      url: ME_PROFILE_PATH,
      headers: auth('bob-token'),
      payload: PROFILE as never,
    });
    expect(
      (await app.inject({ method: 'GET', url: publicProfilePath(bob) })).statusCode,
    ).toBe(200);

    users.promote(alice);
    users.suspend(bob, alice, REASON);

    expect(
      (await app.inject({ method: 'GET', url: publicProfilePath(bob) })).statusCode,
    ).toBe(404);
  });

  it('reappears when the suspension is lifted', async () => {
    // The counterpart. Without it the test above would pass just as well if the
    // public route had simply stopped working.
    const alice = await idOf('alice-token');
    const bob = await idOf('bob-token');
    await app.inject({
      method: 'PUT',
      url: ME_PROFILE_PATH,
      headers: auth('bob-token'),
      payload: PROFILE as never,
    });

    users.promote(alice);
    users.suspend(bob, alice, REASON);
    users.reinstate(bob);

    expect(
      (await app.inject({ method: 'GET', url: publicProfilePath(bob) })).statusCode,
    ).toBe(200);
  });

  it('loses the admin surface even while holding the role', async () => {
    // A suspended administrator is refused every admin route, because none of
    // them opt in. Deliberate: somebody under investigation must not be able to
    // lift their own suspension.
    const alice = await idOf('alice-token');
    users.promote(alice);
    users.suspend(alice, alice, REASON);

    const response = await app.inject({
      method: 'GET',
      url: ADMIN_APPROVALS_PATH,
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('reinstatement', () => {
  it('gives everything back', async () => {
    const { bob } = await suspendBob();
    users.reinstate(bob);

    const response = await app.inject({
      method: 'PUT',
      url: ME_PROFILE_PATH,
      headers: auth('bob-token'),
      payload: PROFILE as never,
    });

    expect(response.statusCode).toBe(200);
  });

  it('leaves nothing behind on the row', async () => {
    // Suspension destroys nothing and reverses cleanly — unlike deletion, which
    // erases. The audit trail is what remembers it ever happened.
    const { bob } = await suspendBob();
    users.reinstate(bob);

    const row = await users.findById(bob);
    expect(row?.suspendedAt).toBeNull();
    expect(row?.suspensionReason).toBeNull();
  });
});

describe('an unsuspended account is unaffected', () => {
  it('can still change their profile', async () => {
    // The counterpart every allowlist needs: without it, a guard that refused
    // everybody would pass every test above.
    await suspendBob();

    const response = await app.inject({
      method: 'PUT',
      url: ME_PROFILE_PATH,
      headers: auth('alice-token'),
      payload: PROFILE as never,
    });

    expect(response.statusCode).toBe(200);
  });
});
