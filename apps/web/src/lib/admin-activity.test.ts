import { describe, expect, it } from 'vitest';
import { fetchAdminActivity } from './admin-activity';
import type { FetchLike } from './admin-activity';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const USER = '11111111-1111-4111-8111-111111111111';
const REASON = 'support ticket 4821, account access query';

// No `sessionId`, and that is what the API actually sends here: the admin route
// withholds it deliberately, because a session id groups an account's actions
// into sittings and that is the usage history ADR 0025 refused support.
const ENTRY = {
  id: '22222222-2222-4222-8222-222222222222',
  action: 'profile.updated',
  targetType: 'profile',
  by: 'subject',
  reason: null,
  ipAddress: '203.0.113.7',
  sessionId: null,
  createdAt: '2026-07-31T09:00:00.000Z',
};

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('fetchAdminActivity', () => {
  it('returns the target’s entries', async () => {
    const outcome = await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      REASON,
      responds(200, JSON.stringify({ entries: [ENTRY] })),
    );
    expect(outcome).toEqual({ kind: 'loaded', entries: [ENTRY] });
  });

  it('reads an entry from an API that predates the "who" field', async () => {
    // The services deploy independently, so the web app is briefly talking to
    // the previous API. An older one served only entries the reader was the
    // actor of, which is exactly `subject` — so the default is correct rather
    // than merely convenient, and a required field would have made the skew
    // window a parse failure on the activity page.
    const withoutBy: Record<string, unknown> = { ...ENTRY };
    delete withoutBy['by'];

    const outcome = await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      REASON,
      responds(200, JSON.stringify({ entries: [withoutBy] })),
    );

    expect(outcome).toEqual({ kind: 'loaded', entries: [ENTRY] });
  });

  it('sends the reason, because the API will not answer without one', async () => {
    let url: string | undefined;
    await fetchAdminActivity(API, TOKEN, USER, REASON, (received) => {
      url = received;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ entries: [] })),
      });
    });

    expect(url).toContain(encodeURIComponent(REASON));
    expect(url).toContain(USER);
  });

  it('encodes a reason containing characters that would break the URL', async () => {
    let url: string | undefined;
    await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      'ticket #12&34 — "urgent"',
      (received) => {
        url = received;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ entries: [] })),
        });
      },
    );

    // An unencoded `&` would silently truncate the reason at the API, which is
    // the sort of failure that leaves a half-sentence in a six-year record.
    expect(url).not.toContain('#12&34');
    expect(url).toContain('%2312%2634');
  });

  it('distinguishes forbidden from signed out', async () => {
    // Different remedies: one needs a second factor or a role, the other needs
    // signing in. Collapsing them would send an administrator to re-authenticate
    // when the real problem is that they never verified a second factor.
    expect(
      await fetchAdminActivity(API, TOKEN, USER, REASON, responds(403, '')),
    ).toEqual({ kind: 'forbidden' });

    expect(
      await fetchAdminActivity(API, TOKEN, USER, REASON, responds(401, '')),
    ).toEqual({ kind: 'signed-out' });
  });

  it('surfaces the API’s complaint about a reason', async () => {
    const outcome = await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      'no',
      responds(400, JSON.stringify({ issues: ['must be at least 12 characters'] })),
    );

    expect(outcome).toEqual({
      kind: 'invalid',
      issues: ['must be at least 12 characters'],
    });
  });

  it('still reports invalid when the 400 body cannot be read', async () => {
    const outcome = await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      'no',
      responds(400, 'not json'),
    );
    expect(outcome.kind).toBe('invalid');
  });

  it('sends nothing without a token', async () => {
    let called = false;
    const outcome = await fetchAdminActivity(API, null, USER, REASON, () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it.each([500, 502])('reports %d as unreachable', async (status) => {
    const outcome = await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      REASON,
      responds(status, ''),
    );
    expect(outcome.kind).toBe('unreachable');
  });

  it('reports a malformed body rather than rendering it', async () => {
    const outcome = await fetchAdminActivity(
      API,
      TOKEN,
      USER,
      REASON,
      responds(200, JSON.stringify([ENTRY])),
    );
    expect(outcome.kind).toBe('malformed');
  });

  it('names the timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const outcome = await fetchAdminActivity(API, TOKEN, USER, REASON, () =>
      Promise.reject(timeout),
    );
    expect(outcome).toMatchObject({ kind: 'unreachable', reason: /5000ms/ });
  });
});
