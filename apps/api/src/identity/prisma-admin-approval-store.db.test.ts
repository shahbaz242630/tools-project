/**
 * Dual approval against a real database.
 *
 * The point of this file is the CHECK constraints. They are the whole reason
 * the rule lives in Postgres rather than only in a service, and a constraint
 * nobody has watched fail is a constraint nobody knows is there.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaAdminApprovalStore } from './prisma-admin-approval-store.js';
import { ApprovalConflictError } from './admin-approval.js';
import type { ApprovableAction } from './admin-approval.js';

const env = loadEnv();

const client = createPrismaClient({
  connectionString: buildPostgresUrl({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_TEST_DB,
  }),
});

const store = new PrismaAdminApprovalStore(client);

const HOUR = 60 * 60 * 1000;
const now = () => new Date();
const inAnHour = () => new Date(Date.now() + HOUR);
const anHourAgo = () => new Date(Date.now() - HOUR);

async function newUser(role: 'USER' | 'ADMIN' = 'USER'): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
      role,
    },
  });
  return user.id;
}

function roleChange(
  userId: string,
  role: 'USER' | 'ADMIN' = 'ADMIN',
): ApprovableAction {
  return { kind: 'role.changed', userId, role };
}

async function pendingProposal(
  proposedById: string,
  targetId: string,
  expiresAt = inAnHour(),
) {
  return store.propose({
    action: roleChange(targetId),
    targetType: 'user',
    targetId,
    proposedById,
    proposedReason: 'support ticket 4821, promoting a colleague',
    expiresAt,
  });
}

beforeEach(async () => {
  await client.adminApproval.deleteMany();
  await client.auditLog.deleteMany();
  // authentication_events is ON DELETE RESTRICT, added in slice 1.11a.
  // Children before parents, in every file — not only the new one.
  await client.authenticationEvent.deleteMany();
  // category_versions is ON DELETE RESTRICT against users, added in slice 2.1.
  // Children before parents, in every file -- not only the new one.
  // listings reference both users and category_versions, ON DELETE RESTRICT
  // (slice 2.4a) — so they clear before either. Children before parents, in
  // every file.
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  // seller_tax_profiles is ON DELETE RESTRICT against users (slice 2.3).
  // Children before parents, in every file — a new foreign key means editing
  // all of them, not only the one the slice was about.
  await client.sellerTaxProfile.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('propose', () => {
  it('stores the action and its payload', async () => {
    const [admin, target] = [await newUser('ADMIN'), await newUser()];
    const proposal = await pendingProposal(admin, target);

    expect(proposal.action).toEqual({
      kind: 'role.changed',
      userId: target,
      role: 'ADMIN',
    });
    expect(proposal.approvedAt).toBeNull();
  });

  it('round-trips the action through the JSON column', async () => {
    // The one place a JSON column is trusted. A payload that no longer matches
    // its action is corrupt in a way no caller could handle, so `find` must
    // rebuild the same object rather than hand back whatever was stored.
    const [admin, target] = [await newUser('ADMIN'), await newUser()];
    const proposal = await pendingProposal(admin, target);

    const read = await store.find(proposal.id);
    expect(read?.action).toEqual(proposal.action);
  });
});

describe('the two-person CHECK constraint', () => {
  it('refuses a self-approval at the database, not only in the service', async () => {
    // The rule the entire mechanism exists for. Written directly against
    // Prisma, bypassing `approveAndApply` entirely, because the point is that
    // Postgres refuses it however the row is reached.
    const [admin, target] = [await newUser('ADMIN'), await newUser()];
    const proposal = await pendingProposal(admin, target);

    await expect(
      client.adminApproval.update({
        where: { id: proposal.id },
        data: {
          approvedById: admin,
          approvedReason: 'approving my own proposal',
          approvedAt: now(),
        },
      }),
    ).rejects.toThrow();
  });

  it('allows a different administrator', async () => {
    // The counterpart. Without it the test above would pass just as well if the
    // constraint refused every approval.
    const [proposer, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(proposer, target);

    await expect(
      client.adminApproval.update({
        where: { id: proposal.id },
        data: {
          approvedById: approver,
          approvedReason: 'agreed, ticket 4821',
          approvedAt: now(),
        },
      }),
    ).resolves.toMatchObject({ approvedById: approver });
  });

  it('refuses a half-written approval', async () => {
    const [admin, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(admin, target);

    await expect(
      client.adminApproval.update({
        where: { id: proposal.id },
        // No reason, no timestamp. A row like this is one no application
        // reading is prepared for.
        data: { approvedById: approver },
      }),
    ).rejects.toThrow();
  });

  it('refuses a proposal that is both approved and cancelled', async () => {
    const [admin, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(admin, target);

    await expect(
      client.adminApproval.update({
        where: { id: proposal.id },
        data: {
          approvedById: approver,
          approvedReason: 'agreed, ticket 4821',
          approvedAt: now(),
          cancelledById: admin,
          cancelledReason: 'withdrawn, ticket 4821',
          cancelledAt: now(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('approveAndApply', () => {
  it('changes the role in the same transaction as the approval', async () => {
    const [proposer, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(proposer, target);

    await store.approveAndApply({
      approvalId: proposal.id,
      byId: approver,
      reason: 'agreed, ticket 4821',
      at: now(),
    });

    expect(await client.user.findUnique({ where: { id: target } })).toMatchObject({
      role: 'ADMIN',
    });
  });

  it('leaves the proposal pending when the effect cannot be applied', async () => {
    // The reason approval and execution share a transaction. The target is
    // hard-deleted between proposal and approval, so the role update fails —
    // and a decision recorded against an effect that never happened would be a
    // lie in a record kept for audit.
    const [proposer, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(proposer, target);
    await client.user.delete({ where: { id: target } });

    await expect(
      store.approveAndApply({
        approvalId: proposal.id,
        byId: approver,
        reason: 'agreed, ticket 4821',
        at: now(),
      }),
    ).rejects.toThrow();

    const after = await store.find(proposal.id);
    expect(after?.approvedAt).toBeNull();
    expect(after?.approvedById).toBeNull();
  });

  it('refuses a second approval of the same proposal', async () => {
    const [proposer, approver, other, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(proposer, target);

    await store.approveAndApply({
      approvalId: proposal.id,
      byId: approver,
      reason: 'agreed, ticket 4821',
      at: now(),
    });

    await expect(
      store.approveAndApply({
        approvalId: proposal.id,
        byId: other,
        reason: 'agreed again, ticket 4821',
        at: now(),
      }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it('refuses the proposer, as a conflict rather than a database error', async () => {
    // The service checks this first, so reaching here means the service was
    // bypassed. It must still be refused, and cleanly — a raw constraint
    // violation would surface as a 500 rather than a 409.
    const [proposer, target] = [await newUser('ADMIN'), await newUser()];
    const proposal = await pendingProposal(proposer, target);

    await expect(
      store.approveAndApply({
        approvalId: proposal.id,
        byId: proposer,
        reason: 'approving my own proposal',
        at: now(),
      }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it('refuses an expired proposal', async () => {
    const [proposer, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(proposer, target, anHourAgo());

    await expect(
      store.approveAndApply({
        approvalId: proposal.id,
        byId: approver,
        reason: 'agreed, ticket 4821',
        at: now(),
      }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);

    // And the role did not change.
    expect(await client.user.findUnique({ where: { id: target } })).toMatchObject({
      role: 'USER',
    });
  });
});

describe('cancel', () => {
  it('lets the proposer withdraw their own', async () => {
    // Deliberately not subject to the two-person rule: cancelling causes no
    // effect, and dual approval is about causing one.
    const [proposer, target] = [await newUser('ADMIN'), await newUser()];
    const proposal = await pendingProposal(proposer, target);

    const cancelled = await store.cancel({
      approvalId: proposal.id,
      byId: proposer,
      reason: 'withdrawn, raised in error',
      at: now(),
    });

    expect(cancelled.cancelledById).toBe(proposer);
    expect(await client.user.findUnique({ where: { id: target } })).toMatchObject({
      role: 'USER',
    });
  });

  it('refuses to cancel something already approved', async () => {
    const [proposer, approver, target] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
    ];
    const proposal = await pendingProposal(proposer, target);
    await store.approveAndApply({
      approvalId: proposal.id,
      byId: approver,
      reason: 'agreed, ticket 4821',
      at: now(),
    });

    await expect(
      store.cancel({
        approvalId: proposal.id,
        byId: proposer,
        reason: 'too late, withdrawing',
        at: now(),
      }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });
});

describe('listPending', () => {
  it('omits approved, cancelled and expired proposals', async () => {
    const [proposer, approver, a, b, c, d] = [
      await newUser('ADMIN'),
      await newUser('ADMIN'),
      await newUser(),
      await newUser(),
      await newUser(),
      await newUser(),
    ];

    const pending = await pendingProposal(proposer, a);
    const approved = await pendingProposal(proposer, b);
    const cancelled = await pendingProposal(proposer, c);
    await pendingProposal(proposer, d, anHourAgo());

    await store.approveAndApply({
      approvalId: approved.id,
      byId: approver,
      reason: 'agreed, ticket 4821',
      at: now(),
    });
    await store.cancel({
      approvalId: cancelled.id,
      byId: proposer,
      reason: 'withdrawn, raised in error',
      at: now(),
    });

    const queue = await store.listPending(now(), 10);
    expect(queue.map((row) => row.id)).toEqual([pending.id]);
  });

  it('honours the limit', async () => {
    const proposer = await newUser('ADMIN');
    for (let index = 0; index < 4; index += 1) {
      await pendingProposal(proposer, await newUser());
    }

    await expect(store.listPending(now(), 2)).resolves.toHaveLength(2);
  });
});
