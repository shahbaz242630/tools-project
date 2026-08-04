import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ME_ACTIVITY_PATH,
  ME_PATH,
  ME_PROFILE_PATH,
  activityResponseSchema,
  adminAccountSchema,
  adminSuspensionPath,
  adminUserPath,
  adminUserViewSchema,
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
import { createProfileFakes } from '../profiles/testing/fakes.js';
import type { ProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from './testing/fakes.js';
import type { IdentityFakes } from './testing/fakes.js';

/**
 * Suspending and reinstating through the real application.
 *
 * One administrator does it, deliberately — this is the slice that does *not*
 * use dual approval (ADR 0024). What stands in for the second pair of eyes is
 * asserted here: a mandatory reason, an audit entry with real before/after
 * state, and the person reading both.
 */

const ADMIN = {
  clerkUserId: 'user_admin',
  sessionId: 'sess_ad',
  email: 'admin@example.com',
  secondFactorAgeMinutes: 5,
};
const SECOND = {
  clerkUserId: 'user_second',
  sessionId: 'sess_2',
  email: 'second@example.com',
  secondFactorAgeMinutes: 5,
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const REASON = 'suspected fraud on ticket 4821, pending review';
const LIFTED = 'review complete, ticket 4821 closed with no action';

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let profiles: ProfileFakes;

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  profiles = createProfileFakes(audit);
  identity.sessionVerifier
    .accept('admin-token', ADMIN)
    .accept('second-token', SECOND)
    .accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: createCatalogueFakes().service,
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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

async function promote(token: string): Promise<string> {
  const id = await idOf(token);
  identity.users.promote(id);
  return id;
}

const decide = (
  token: string,
  userId: string,
  decision: 'suspend' | 'reinstate',
  reason = decision === 'suspend' ? REASON : LIFTED,
) =>
  app.inject({
    method: 'POST',
    url: adminSuspensionPath(userId, decision),
    headers: auth(token),
    payload: { reason } as never,
  });

describe('the guard', () => {
  it('rejects an unauthenticated request', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: adminSuspensionPath('11111111-1111-4111-8111-111111111111', 'suspend'),
          payload: { reason: REASON } as never,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('refuses an ordinary user', async () => {
    const bob = await idOf('bob-token');
    expect((await decide('admin-token', bob, 'suspend')).statusCode).toBe(403);
  });

  it('refuses an administrator with no verified second factor', async () => {
    // MFA comes from the guard, for the role rather than the route, so a new
    // admin route cannot exist without it (ADR 0021).
    const bob = await idOf('bob-token');
    await promote('bob-token');
    identity.sessionVerifier.accept('bob-token', { ...BOB });

    expect((await decide('bob-token', bob, 'suspend')).statusCode).toBe(403);
  });
});

describe('suspending', () => {
  it('suspends the account and reports it back', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');

    const response = await decide('admin-token', bob, 'suspend');
    expect(response.statusCode).toBe(200);

    const account = adminAccountSchema.parse(response.json());
    expect(account.suspendedAt).not.toBeNull();
    expect(account.suspensionReason).toBe(REASON);
  });

  it('actually stops the person acting', async () => {
    // The route is only worth anything if the state it writes is the state the
    // guard reads. Asserted end to end rather than on the response body.
    await promote('admin-token');
    const bob = await idOf('bob-token');

    await decide('admin-token', bob, 'suspend');

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: ME_PROFILE_PATH,
          headers: auth('bob-token'),
          payload: {
            displayName: 'Bob B.',
            phone: null,
            address: null,
          } as never,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('records before and after state that differ', async () => {
    // BRD §8.13 asks for "actor, reason, target and before/after state" on
    // every admin action. This is the first one that has any — every admin
    // action before it was a read, and a read changes nothing.
    const admin = await promote('admin-token');
    const bob = await idOf('bob-token');

    await decide('admin-token', bob, 'suspend');

    const entry = audit.log.entries().find((e) => e.action === 'account.suspended');
    expect(entry).toMatchObject({ actorId: admin, targetId: bob, reason: REASON });
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('shows the person why, on their own activity page', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');
    await decide('admin-token', bob, 'suspend');

    const { entries } = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );

    expect(entries.find((e) => e.action === 'account.suspended')).toMatchObject({
      by: 'administrator',
      reason: REASON,
      // Never the administrator's address (ADR 0021's correction).
      ipAddress: null,
    });
  });

  it('refuses to suspend an already-suspended account', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');
    await decide('admin-token', bob, 'suspend');

    expect((await decide('admin-token', bob, 'suspend')).statusCode).toBe(409);
  });

  it('refuses to suspend yourself', async () => {
    // A one-way door with no handle on the far side: a suspended administrator
    // loses the admin surface, so they could not undo it.
    const admin = await promote('admin-token');

    const response = await decide('admin-token', admin, 'suspend');
    expect(response.statusCode).toBe(409);
    expect((await identity.users.findById(admin))?.suspendedAt).toBeNull();
  });

  it('allows suspending an administrator while another remains', async () => {
    // The reachable case, and the one that must keep working: two
    // administrators, so stopping one leaves somebody able to undo it.
    await promote('admin-token');
    const second = await promote('second-token');

    expect((await decide('admin-token', second, 'suspend')).statusCode).toBe(200);
    expect(await identity.users.countAdministrators()).toBe(1);
  });

  it('refuses to leave zero usable administrators', async () => {
    // **Called on the service, not through the route, and that is the point.**
    //
    // Through the route this rule cannot fire: the caller must themselves be a
    // usable administrator, so at the moment of the check there are always at
    // least two — them and the target. Driving it over HTTP would produce a 409
    // for "already suspended" or "you cannot suspend yourself" and pass for the
    // wrong reason, which is exactly what the first version of this test did.
    //
    // It is kept because the service is not only reachable over HTTP. BRD §5.1
    // gives suspension to Trust & Safety, and an automated risk check
    // suspending somebody has no session behind it and no such guarantee.
    const admin = await promote('admin-token');

    await expect(
      identity.service.suspend(
        {
          userId: '00000000-0000-4000-8000-0000000000ff',
          ipAddress: null,
          sessionId: null,
        },
        admin,
        REASON,
      ),
    ).rejects.toThrow(/last administrator/);

    expect((await identity.users.findById(admin))?.suspendedAt).toBeNull();
  });

  it('refuses a deleted account', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');
    await identity.service.requestDeletion({
      userId: bob,
      ipAddress: null,
      sessionId: null,
    });

    expect((await decide('admin-token', bob, 'suspend')).statusCode).toBe(409);
  });
});

describe('reinstating', () => {
  it('gives the account back', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');
    await decide('admin-token', bob, 'suspend');

    const response = await decide('admin-token', bob, 'reinstate');
    expect(response.statusCode).toBe(200);

    const account = adminAccountSchema.parse(response.json());
    expect(account.suspendedAt).toBeNull();
    // Cleared, not left behind. A stale reason on an active account is a state
    // the CHECK constraint would never catch.
    expect(account.suspensionReason).toBeNull();
  });

  it('refuses an account that is not suspended', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');

    expect((await decide('admin-token', bob, 'reinstate')).statusCode).toBe(409);
  });

  it('records its own reason, distinct from the suspension’s', async () => {
    // "Why is this person back" is exactly as worth recording as why they were
    // stopped, and the two must not be confusable in the trail.
    await promote('admin-token');
    const bob = await idOf('bob-token');
    await decide('admin-token', bob, 'suspend');
    await decide('admin-token', bob, 'reinstate');

    const entry = audit.log.entries().find((e) => e.action === 'account.reinstated');
    expect(entry).toMatchObject({ targetId: bob, reason: LIFTED });
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });
});

describe('validation', () => {
  it.each([
    ['absent', ''],
    ['too short', 'because'],
    ['only whitespace', '            '],
  ])('refuses a reason that is %s', async (_label, reason) => {
    await promote('admin-token');
    const bob = await idOf('bob-token');

    expect((await decide('admin-token', bob, 'suspend', reason)).statusCode).toBe(400);
  });

  it('records nothing when the reason was refused', async () => {
    await promote('admin-token');
    const bob = await idOf('bob-token');

    await decide('admin-token', bob, 'suspend', 'no');

    expect(
      audit.log.entries().filter((e) => e.action === 'account.suspended'),
    ).toHaveLength(0);
  });

  it('answers 404 for a malformed account id, and records nothing', async () => {
    await promote('admin-token');

    expect((await decide('admin-token', 'banana', 'suspend')).statusCode).toBe(404);
    expect(
      audit.log.entries().filter((e) => e.action === 'account.suspended'),
    ).toHaveLength(0);
  });

  it('answers 409 for a well-formed id that is not an account', async () => {
    await promote('admin-token');

    expect(
      (await decide('admin-token', '11111111-1111-4111-8111-111111111111', 'suspend'))
        .statusCode,
    ).toBe(409);
  });
});

describe('what support sees', () => {
  it('reports the suspension on the account view', async () => {
    // Somebody writing in about an account that cannot do anything is the most
    // likely support case, so the lookup has to answer it without a second trip.
    await promote('admin-token');
    const bob = await idOf('bob-token');
    await decide('admin-token', bob, 'suspend');

    const view = adminUserViewSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: adminUserPath(bob, 'checking a suspension, ticket 4821'),
          headers: auth('admin-token'),
        })
      ).json(),
    );

    expect(view.account.suspendedAt).not.toBeNull();
    expect(view.account.suspensionReason).toBe(REASON);
  });
});
