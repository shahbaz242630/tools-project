import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalConflictError, approvalState } from './admin-approval.js';
import type { AdminApproval } from './admin-approval.js';
import { ApprovalRefusedError } from './identity.service.js';
import { createIdentityFakes } from './testing/fakes.js';
import type { IdentityFakes } from './testing/fakes.js';

/**
 * Dual approval, against the identity module's fakes.
 *
 * The database tests beside this one prove Postgres refuses a self-approval
 * whatever code reaches the row. These prove the *rules* around it: what may be
 * proposed, what may be approved, and the two cases where refusing is the whole
 * point — approving your own proposal, and demoting the last administrator.
 */

const REASON = 'support ticket 4821, promoting a colleague';
const AGREED = 'agreed, ticket 4821 checked';

let fakes: IdentityFakes;
let alice: string;
let bob: string;
let carol: string;

/** An actor, as a controller assembles one from a verified session. */
const actor = (userId: string) => ({ userId, ipAddress: '203.0.113.7' });

async function provision(clerkUserId: string, email: string): Promise<string> {
  const user = await fakes.service.resolveSession({
    clerkUserId,
    sessionId: `sess_${clerkUserId}`,
    email,
    secondFactorAgeMinutes: 5,
  });
  return user.id;
}

/**
 * Age a proposal past its window.
 *
 * Reaches into the double rather than waiting, because the window is a day and
 * a test that waited is a test nobody runs. The expiry rule itself is pinned
 * against real Postgres in the database test.
 */
async function expire(approvalId: string): Promise<void> {
  const proposal = fakes.approvals.all().find((row) => row.id === approvalId);
  if (proposal === undefined) throw new Error(`no such proposal: ${approvalId}`);
  fakes.approvals.replace({
    ...proposal,
    expiresAt: new Date(Date.now() - 60_000),
  });
  await Promise.resolve();
}

beforeEach(async () => {
  fakes = createIdentityFakes();
  alice = await provision('user_alice', 'alice@example.com');
  bob = await provision('user_bob', 'bob@example.com');
  carol = await provision('user_carol', 'carol@example.com');
  fakes.users.promote(alice);
  fakes.users.promote(bob);
});

const propose = (proposer: string, target: string, role: 'ADMIN' | 'USER' = 'ADMIN') =>
  fakes.service.proposeRoleChange(actor(proposer), target, role, REASON);

describe('proposeRoleChange', () => {
  it('creates a pending proposal without changing anything', async () => {
    const proposal = await propose(alice, carol);

    expect(approvalState(proposal, new Date())).toBe('pending');
    // The whole point: proposing is not doing.
    expect((await fakes.users.findById(carol))?.role).toBe('USER');
  });

  it('records it against the target, so they can see it', async () => {
    // Same reasoning as an administrative read (ADR 0021): a person is entitled
    // to know somebody proposed changing their account, and why.
    await propose(alice, carol);

    expect(
      fakes.audit.log.entries().find((e) => e.action === 'admin.approval_proposed'),
    ).toMatchObject({ actorId: alice, targetId: carol, reason: REASON });
  });

  it('refuses an account that does not exist', async () => {
    await expect(
      propose(alice, '00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);
  });

  it('refuses a role the account already holds', async () => {
    // A no-op proposal is a real approval somebody has to read and agree to for
    // no effect, which is how a queue becomes something people clear.
    await expect(propose(alice, bob)).rejects.toBeInstanceOf(ApprovalRefusedError);
  });

  it('refuses a deleted account', async () => {
    await fakes.service.requestDeletion(actor(carol));

    await expect(propose(alice, carol)).rejects.toBeInstanceOf(ApprovalRefusedError);
  });

  it('records nothing when it refuses', async () => {
    // The proposal did not happen, so the trail must not claim it did.
    await expect(propose(alice, bob)).rejects.toThrow();

    expect(
      fakes.audit.log.entries().filter((e) => e.action === 'admin.approval_proposed'),
    ).toHaveLength(0);
  });
});

describe('approve', () => {
  it('applies the change when a second administrator agrees', async () => {
    const proposal = await propose(alice, carol);

    await fakes.service.approve(actor(bob), proposal.id, AGREED);

    expect((await fakes.users.findById(carol))?.role).toBe('ADMIN');
  });

  it('refuses the proposer, however well-intentioned', async () => {
    // The rule the entire mechanism exists for.
    const proposal = await propose(alice, carol);

    await expect(
      fakes.service.approve(actor(alice), proposal.id, AGREED),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);

    expect((await fakes.users.findById(carol))?.role).toBe('USER');
  });

  it('records the change with differing before and after state', async () => {
    const proposal = await propose(alice, carol);
    await fakes.service.approve(actor(bob), proposal.id, AGREED);

    const entry = fakes.audit.log
      .entries()
      .find((e) => e.action === 'admin.approval_granted');

    expect(entry).toMatchObject({ actorId: bob, targetId: carol, reason: AGREED });
    // BRD §8.13 asks for before/after state on every admin action. This is the
    // first admin action that has any, because it is the first admin *write*.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('refuses a proposal that was already decided', async () => {
    const proposal = await propose(alice, carol);
    await fakes.service.approve(actor(bob), proposal.id, AGREED);

    await expect(
      fakes.service.approve(actor(bob), proposal.id, AGREED),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it('refuses an expired proposal', async () => {
    const proposal = await propose(alice, carol);
    await expire(proposal.id);

    await expect(
      fakes.service.approve(actor(bob), proposal.id, AGREED),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
    expect((await fakes.users.findById(carol))?.role).toBe('USER');
  });

  it('refuses an unknown proposal', async () => {
    await expect(
      fakes.service.approve(actor(bob), '00000000-0000-4000-9000-0000000000ff', AGREED),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);
  });

  it('refuses to demote the last administrator', async () => {
    // The most permanent lockout available. Role assignment *is* this
    // mechanism, so with no administrator left there is nobody to promote
    // anybody and no route that could — recovery would be a database write on
    // a production box.
    const proposal = await propose(alice, bob, 'USER');

    // Alice steps down in between, leaving Bob as the only administrator.
    const stepped = await fakes.users.findById(alice);
    fakes.users.seed({ ...stepped!, role: 'USER' });

    await expect(
      fakes.service.approve(actor(alice), proposal.id, AGREED),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);
    expect((await fakes.users.findById(bob))?.role).toBe('ADMIN');
  });

  it('re-checks the target between proposal and approval', async () => {
    // A day may pass. The account can be deleted in between, and applying the
    // change then would be acting on facts nobody agreed to.
    const proposal = await propose(alice, carol);
    await fakes.service.requestDeletion(actor(carol));

    await expect(
      fakes.service.approve(actor(bob), proposal.id, AGREED),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);
  });
});

describe('cancelApproval', () => {
  it('lets the proposer withdraw their own', async () => {
    // Deliberately not subject to the two-person rule: cancelling causes no
    // effect, and dual approval is about causing one.
    const proposal = await propose(alice, carol);

    const cancelled = await fakes.service.cancelApproval(
      actor(alice),
      proposal.id,
      'withdrawn, raised in error',
    );

    expect(cancelled.cancelledById).toBe(alice);
    expect((await fakes.users.findById(carol))?.role).toBe('USER');
  });

  it('refuses to cancel something already approved', async () => {
    const proposal = await propose(alice, carol);
    await fakes.service.approve(actor(bob), proposal.id, AGREED);

    await expect(
      fakes.service.cancelApproval(actor(alice), proposal.id, 'too late'),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });
});

describe('listPendingApprovals', () => {
  it('omits what has already been decided', async () => {
    const kept = await propose(alice, carol);
    const withdrawn = await propose(alice, bob, 'USER');
    await fakes.service.cancelApproval(actor(alice), withdrawn.id, 'withdrawn, error');

    const pending = await fakes.service.listPendingApprovals();
    expect(pending.map((p) => p.id)).toEqual([kept.id]);
  });
});

describe('approvalState', () => {
  const base: AdminApproval = {
    id: '00000000-0000-4000-9000-000000000001',
    action: { kind: 'role.changed', userId: 'u', role: 'ADMIN' },
    targetType: 'user',
    targetId: 'u',
    proposedById: 'a',
    proposedReason: REASON,
    proposedAt: new Date('2026-08-01T09:00:00.000Z'),
    expiresAt: new Date('2026-08-02T09:00:00.000Z'),
    approvedById: null,
    approvedReason: null,
    approvedAt: null,
    cancelledById: null,
    cancelledReason: null,
    cancelledAt: null,
  };

  const during = new Date('2026-08-01T12:00:00.000Z');
  const after = new Date('2026-08-03T09:00:00.000Z');

  it('is pending inside the window', () => {
    expect(approvalState(base, during)).toBe('pending');
  });

  it('is expired once the window closes', () => {
    expect(approvalState(base, after)).toBe('expired');
  });

  it('expires exactly at the boundary, not a moment later', () => {
    expect(approvalState(base, base.expiresAt)).toBe('expired');
  });

  it('keeps an approval past its expiry rather than calling it expired', () => {
    // Checking expiry first would make yesterday's approvals read as expired
    // today, which is a lie about something that did happen.
    const approved = { ...base, approvedById: 'b', approvedAt: during };
    expect(approvalState(approved, after)).toBe('approved');
  });

  it('keeps a cancellation past its expiry too', () => {
    const cancelled = { ...base, cancelledById: 'a', cancelledAt: during };
    expect(approvalState(cancelled, after)).toBe('cancelled');
  });
});
