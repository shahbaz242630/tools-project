import { describe, expect, it } from 'vitest';
import {
  decideApproval,
  fetchPendingApprovals,
  proposeRoleChange,
} from './admin-approvals';
import type { FetchLike } from './admin-approvals';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const REASON = 'support ticket 4821, promoting a colleague';

const APPROVAL = {
  id: ID,
  action: { kind: 'role.changed', userId: USER, role: 'ADMIN' },
  targetId: USER,
  state: 'pending',
  proposedById: '33333333-3333-4333-8333-333333333333',
  proposedReason: REASON,
  proposedAt: '2026-08-01T09:00:00.000Z',
  expiresAt: '2026-08-02T09:00:00.000Z',
  approvedById: null,
  approvedReason: null,
  approvedAt: null,
  cancelledById: null,
  cancelledReason: null,
  cancelledAt: null,
};

function responds(status: number, body = ''): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('fetchPendingApprovals', () => {
  it('returns the queue', async () => {
    const outcome = await fetchPendingApprovals(
      API,
      TOKEN,
      responds(200, JSON.stringify({ approvals: [APPROVAL] })),
    );

    expect(outcome).toEqual({ kind: 'loaded', value: [APPROVAL] });
  });

  it('is signed out without a token, without calling the API', async () => {
    let called = false;
    const outcome = await fetchPendingApprovals(API, null, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reports a mis-shaped queue as malformed rather than rendering it', async () => {
    const outcome = await fetchPendingApprovals(
      API,
      TOKEN,
      responds(200, JSON.stringify({ approvals: [{ id: 'not-a-uuid' }] })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports an unreachable API rather than an empty queue', async () => {
    // The distinction the whole component rests on: "nothing is waiting" is a
    // claim about a control, and making it because the API timed out would be
    // a false reassurance.
    const outcome = await fetchPendingApprovals(API, TOKEN, () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );

    expect(outcome).toEqual({ kind: 'unreachable', reason: 'connect ECONNREFUSED' });
  });
});

describe('proposeRoleChange', () => {
  it('posts the proposal and returns it', async () => {
    let method: string | undefined;
    let body: string | undefined;

    const outcome = await proposeRoleChange(
      API,
      TOKEN,
      { userId: USER, role: 'ADMIN', reason: REASON },
      (_url, init) => {
        method = init?.method;
        body = init?.body;
        return Promise.resolve({
          status: 201,
          text: () => Promise.resolve(JSON.stringify(APPROVAL)),
        });
      },
    );

    expect(method).toBe('POST');
    expect(JSON.parse(body ?? '{}')).toEqual({
      userId: USER,
      role: 'ADMIN',
      reason: REASON,
    });
    expect(outcome).toEqual({ kind: 'loaded', value: APPROVAL });
  });

  it('separates a refusal from a malformed request', async () => {
    // 409 means the request was fine and the world disagreed. Telling somebody
    // to correct a form that is already correct sends them round a loop.
    const outcome = await proposeRoleChange(
      API,
      TOKEN,
      { userId: USER, role: 'ADMIN', reason: REASON },
      responds(409, JSON.stringify({ message: 'that account is already ADMIN' })),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'that account is already ADMIN',
    });
  });

  it('falls back to a usable message when a refusal has no body', async () => {
    const outcome = await proposeRoleChange(
      API,
      TOKEN,
      { userId: USER, role: 'ADMIN', reason: REASON },
      responds(409, 'not json'),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason.length).toBeGreaterThan(0);
  });

  it('surfaces the issues from a rejected reason', async () => {
    const outcome = await proposeRoleChange(
      API,
      TOKEN,
      { userId: USER, role: 'ADMIN', reason: 'no' },
      responds(400, JSON.stringify({ issues: ['The reason must be at least 12'] })),
    );

    expect(outcome).toEqual({
      kind: 'invalid',
      issues: ['The reason must be at least 12'],
    });
  });
});

describe('decideApproval', () => {
  it.each(['approve', 'cancel'] as const)('posts a %s decision', async (decision) => {
    let url: string | undefined;
    let body: string | undefined;

    await decideApproval(API, TOKEN, ID, decision, REASON, (received, init) => {
      url = received;
      body = init?.body;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify(APPROVAL)),
      });
    });

    expect(url).toContain(`/admin/approvals/${ID}/${decision}`);
    expect(JSON.parse(body ?? '{}')).toEqual({ reason: REASON });
  });

  it('reports a self-approval as a refusal, not a permission failure', async () => {
    // 403 would mean "you may not approve anything", which is wrong — this
    // administrator is a perfectly good approver for somebody else's proposal.
    const outcome = await decideApproval(
      API,
      TOKEN,
      ID,
      'approve',
      REASON,
      responds(
        409,
        JSON.stringify({ message: 'you proposed this, so somebody else has to' }),
      ),
    );

    expect(outcome.kind).toBe('refused');
  });

  it('distinguishes forbidden from signed out', async () => {
    await expect(
      decideApproval(API, TOKEN, ID, 'approve', REASON, responds(403)),
    ).resolves.toEqual({ kind: 'forbidden' });

    await expect(
      decideApproval(API, TOKEN, ID, 'approve', REASON, responds(401)),
    ).resolves.toEqual({ kind: 'signed-out' });
  });

  it('reports an unknown proposal as not found', async () => {
    await expect(
      decideApproval(API, TOKEN, ID, 'approve', REASON, responds(404)),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('forwards the client address when it has one', async () => {
    let headers: Record<string, string> | undefined;

    await decideApproval(
      API,
      TOKEN,
      ID,
      'approve',
      REASON,
      (_url, init) => {
        headers = init?.headers;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify(APPROVAL)),
        });
      },
      '203.0.113.7',
    );

    expect(headers?.['x-client-ip']).toBe('203.0.113.7');
    expect(headers?.['content-type']).toBe('application/json');
  });
});
