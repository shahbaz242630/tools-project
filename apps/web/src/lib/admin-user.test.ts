import { describe, expect, it } from 'vitest';
import { fetchAdminUser } from './admin-user';
import type { FetchLike } from './admin-user';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const USER = '11111111-1111-4111-8111-111111111111';
const REASON = 'support ticket 4821, cannot sign in';

const VIEW = {
  account: {
    id: USER,
    email: 'bob@example.com',
    role: 'USER',
    createdAt: '2026-07-15T09:00:00.000Z',
    deletedAt: null,
    deletionRequestedAt: null,
    suspendedAt: null,
    suspensionReason: null,
  },
  profile: {
    displayName: 'Bob B.',
    hasPhone: true,
    address: { town: 'Bristol', outwardCode: 'BS7' },
    updatedAt: '2026-07-31T09:00:00.000Z',
  },
};

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('fetchAdminUser', () => {
  it('returns the account view', async () => {
    const outcome = await fetchAdminUser(
      API,
      TOKEN,
      USER,
      REASON,
      responds(200, JSON.stringify(VIEW)),
    );
    expect(outcome).toEqual({ kind: 'loaded', view: VIEW });
  });

  it('sends the reason, because the API will not answer without one', async () => {
    let url: string | undefined;
    await fetchAdminUser(API, TOKEN, USER, REASON, (received) => {
      url = received;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify(VIEW)),
      });
    });

    expect(url).toContain(`reason=${encodeURIComponent(REASON)}`);
  });

  it('reports a missing account separately from a failure', async () => {
    // The remedy differs: a mistyped id is retyped, an unreachable API is not.
    const outcome = await fetchAdminUser(API, TOKEN, USER, REASON, responds(404, ''));
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('distinguishes forbidden from signed out', async () => {
    // Authenticated but either lacking the role or without a recent second
    // factor — telling somebody to sign in again would be wrong advice.
    await expect(
      fetchAdminUser(API, TOKEN, USER, REASON, responds(403, '')),
    ).resolves.toEqual({ kind: 'forbidden' });

    await expect(
      fetchAdminUser(API, TOKEN, USER, REASON, responds(401, '')),
    ).resolves.toEqual({ kind: 'signed-out' });
  });

  it('is signed out without a token, without calling the API', async () => {
    let called = false;
    const outcome = await fetchAdminUser(API, null, USER, REASON, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('surfaces the issues from a rejected reason', async () => {
    const outcome = await fetchAdminUser(
      API,
      TOKEN,
      USER,
      REASON,
      responds(400, JSON.stringify({ issues: ['The reason must be at least 12'] })),
    );

    expect(outcome).toEqual({
      kind: 'invalid',
      issues: ['The reason must be at least 12'],
    });
  });

  it('treats a 400 with an unreadable body as still a 400', async () => {
    const outcome = await fetchAdminUser(
      API,
      TOKEN,
      USER,
      REASON,
      responds(400, 'not json'),
    );
    expect(outcome.kind).toBe('invalid');
  });

  it('reports a mis-shaped response as malformed rather than rendering it', async () => {
    // The services deploy independently, so one is always briefly talking to
    // the other's previous version. A half-parsed account view rendered as a
    // real one is worse than an error.
    const outcome = await fetchAdminUser(
      API,
      TOKEN,
      USER,
      REASON,
      responds(200, JSON.stringify({ account: { id: 'not-a-uuid' } })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports an unreachable API rather than throwing', async () => {
    const outcome = await fetchAdminUser(API, TOKEN, USER, REASON, () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );

    expect(outcome).toEqual({
      kind: 'unreachable',
      reason: 'connect ECONNREFUSED',
    });
  });

  it('forwards the client address when it has one', async () => {
    let headers: Record<string, string> | undefined;
    await fetchAdminUser(
      API,
      TOKEN,
      USER,
      REASON,
      (_url, init) => {
        headers = init?.headers;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify(VIEW)),
        });
      },
      '203.0.113.7',
    );

    expect(headers?.['x-client-ip']).toBe('203.0.113.7');
  });
});
