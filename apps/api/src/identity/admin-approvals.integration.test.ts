import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ADMIN_APPROVALS_PATH,
  ME_ACTIVITY_PATH,
  ME_PATH,
  activityResponseSchema,
  adminApprovalDecisionPath,
  adminApprovalListSchema,
  adminApprovalSchema,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import type { ProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from './testing/fakes.js';
import type { IdentityFakes } from './testing/fakes.js';

/**
 * Dual approval against the real application — real routing, real guard.
 *
 * The service tests prove the rules and the database tests prove Postgres
 * refuses a self-approval whatever reaches the row. This proves the two
 * administrators actually have to be two *sessions*: that the guard is
 * attached, that MFA is required of both, and that the whole loop works end to
 * end without either of them ever touching the database.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
  secondFactorAgeMinutes: 5,
};
const BOB = {
  clerkUserId: 'user_bob',
  sessionId: 'sess_b',
  email: 'bob@example.com',
  secondFactorAgeMinutes: 5,
};
const CAROL = {
  clerkUserId: 'user_carol',
  sessionId: 'sess_c',
  email: 'carol@example.com',
  secondFactorAgeMinutes: 5,
};
/** An administrator whose token carries no factor claim at all. */
const DAVE = {
  clerkUserId: 'user_dave',
  sessionId: 'sess_d',
  email: 'dave@example.com',
};

const REASON = 'support ticket 4821, promoting a colleague';
const AGREED = 'agreed, ticket 4821 checked';

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let profiles: ProfileFakes;

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  profiles = createProfileFakes(audit);
  identity.sessionVerifier
    .accept('alice-token', ALICE)
    .accept('bob-token', BOB)
    .accept('carol-token', CAROL)
    .accept('dave-token', DAVE);

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

/** Provision the account behind a token, then make it an administrator. */
async function promote(token: string): Promise<string> {
  const id = await idOf(token);
  identity.users.promote(id);
  return id;
}

const proposeAs = (token: string, userId: string, role = 'ADMIN', reason = REASON) =>
  app.inject({
    method: 'POST',
    url: ADMIN_APPROVALS_PATH,
    headers: auth(token),
    payload: { userId, role, reason } as never,
  });

const decideAs = (
  token: string,
  id: string,
  decision: 'approve' | 'cancel',
  reason = AGREED,
) =>
  app.inject({
    method: 'POST',
    url: adminApprovalDecisionPath(id, decision),
    headers: auth(token),
    payload: { reason } as never,
  });

describe('the guard on every approval route', () => {
  it('rejects an unauthenticated request', async () => {
    expect(
      (await app.inject({ method: 'GET', url: ADMIN_APPROVALS_PATH })).statusCode,
    ).toBe(401);
  });

  it('refuses an ordinary user', async () => {
    const carol = await idOf('carol-token');
    expect((await proposeAs('alice-token', carol)).statusCode).toBe(403);
  });

  it('refuses an administrator with no verified second factor', async () => {
    // MFA is required of administrators at the guard, for the role rather than
    // the route, so a new admin route cannot exist without it (ADR 0021).
    const carol = await idOf('carol-token');
    await promote('dave-token');

    expect((await proposeAs('dave-token', carol)).statusCode).toBe(403);
  });
});

describe('the two-administrator loop', () => {
  it('takes two sessions to change a role', async () => {
    // The slice in one test: Alice proposes, nothing happens; Bob agrees, and
    // only then does Carol's role change.
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');

    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );
    expect(proposed.state).toBe('pending');
    expect((await identity.users.findById(carol))?.role).toBe('USER');

    const approved = adminApprovalSchema.parse(
      (await decideAs('bob-token', proposed.id, 'approve')).json(),
    );

    expect(approved.state).toBe('approved');
    expect((await identity.users.findById(carol))?.role).toBe('ADMIN');
  });

  it('answers 201 for a proposal, because a proposal is not the change', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');

    expect((await proposeAs('alice-token', carol)).statusCode).toBe(201);
  });

  it('refuses the proposer with 409, not 403', async () => {
    // 403 would mean "you may not do this at all", which is wrong — Alice is a
    // perfectly good approver for anybody else's proposal.
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');

    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );
    const response = await decideAs('alice-token', proposed.id, 'approve');

    expect(response.statusCode).toBe(409);
    expect((await identity.users.findById(carol))?.role).toBe('USER');
  });

  it('refuses a second decision on the same proposal', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );

    await decideAs('bob-token', proposed.id, 'approve');
    expect((await decideAs('bob-token', proposed.id, 'approve')).statusCode).toBe(409);
  });

  it('lets a proposal be withdrawn by the person who raised it', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );

    const cancelled = adminApprovalSchema.parse(
      (
        await decideAs(
          'alice-token',
          proposed.id,
          'cancel',
          'withdrawn, raised in error',
        )
      ).json(),
    );

    expect(cancelled.state).toBe('cancelled');
    expect((await identity.users.findById(carol))?.role).toBe('USER');
  });
});

describe('the queue', () => {
  it('lists what is waiting and drops what has been decided', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );

    const before = adminApprovalListSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ADMIN_APPROVALS_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );
    expect(before.approvals.map((a) => a.id)).toEqual([proposed.id]);

    await decideAs('bob-token', proposed.id, 'approve');

    const after = adminApprovalListSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ADMIN_APPROVALS_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );
    expect(after.approvals).toEqual([]);
  });

  it('carries both administrators’ reasons', async () => {
    // An approval nobody can attribute is not dual approval, it is two clicks.
    const carol = await idOf('carol-token');
    await promote('alice-token');
    const bob = await promote('bob-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );

    const approved = adminApprovalSchema.parse(
      (await decideAs('bob-token', proposed.id, 'approve')).json(),
    );

    expect(approved.proposedReason).toBe(REASON);
    expect(approved.approvedReason).toBe(AGREED);
    expect(approved.approvedById).toBe(bob);
  });
});

describe('validation', () => {
  it.each([
    ['absent', ''],
    ['too short', 'because'],
    ['only whitespace', '            '],
  ])('refuses a proposal whose reason is %s', async (_label, reason) => {
    const carol = await idOf('carol-token');
    await promote('alice-token');

    expect((await proposeAs('alice-token', carol, 'ADMIN', reason)).statusCode).toBe(
      400,
    );
  });

  it('refuses a decision with no reason', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );

    expect((await decideAs('bob-token', proposed.id, 'approve', 'no')).statusCode).toBe(
      400,
    );
  });

  it('refuses a role that is not a role', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');

    expect((await proposeAs('alice-token', carol, 'SUPERUSER')).statusCode).toBe(400);
  });

  it('answers 404 for a malformed proposal id', async () => {
    await promote('alice-token');
    expect((await decideAs('alice-token', 'banana', 'approve')).statusCode).toBe(404);
  });

  it('answers 409 for a well-formed id that is not a proposal', async () => {
    // Distinct from the malformed case: this one *could* have been a proposal,
    // so the refusal is about the state of the world rather than the request.
    await promote('alice-token');
    expect(
      (await decideAs('alice-token', '00000000-0000-4000-9000-0000000000ff', 'approve'))
        .statusCode,
    ).toBe(409);
  });
});

describe('what the subject sees', () => {
  it('shows them that somebody proposed changing their role, and why', async () => {
    // The same control an administrative read has: a person is entitled to know
    // their account was reached into, and to read the reason.
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );
    await decideAs('bob-token', proposed.id, 'approve');

    const { entries } = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('carol-token'),
        })
      ).json(),
    );

    expect(entries.find((e) => e.action === 'admin.approval_proposed')).toMatchObject({
      by: 'administrator',
      reason: REASON,
    });
    expect(entries.find((e) => e.action === 'admin.approval_granted')).toMatchObject({
      by: 'administrator',
      reason: AGREED,
    });
  });

  it('does not give them either administrator’s address', async () => {
    const carol = await idOf('carol-token');
    await promote('alice-token');
    await promote('bob-token');
    const proposed = adminApprovalSchema.parse(
      (await proposeAs('alice-token', carol)).json(),
    );
    await decideAs('bob-token', proposed.id, 'approve');

    const { entries } = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('carol-token'),
        })
      ).json(),
    );

    expect(
      entries
        .filter((e) => e.action.startsWith('admin.'))
        .every((e) => e.ipAddress === null),
    ).toBe(true);
  });
});
