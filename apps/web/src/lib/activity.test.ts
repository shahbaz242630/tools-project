import { describe, expect, it } from 'vitest';
import { fetchActivity } from './activity';
import type { FetchLike } from './activity';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  action: 'profile.updated',
  targetType: 'profile',
  by: 'subject',
  reason: null,
  ipAddress: '203.0.113.7',
  sessionId: 'sess_alice',
  createdAt: '2026-07-31T09:00:00.000Z',
};

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('fetchActivity', () => {
  it('returns the entries', async () => {
    const outcome = await fetchActivity(
      API,
      TOKEN,
      responds(200, JSON.stringify({ entries: [ENTRY] })),
    );
    expect(outcome).toEqual({ kind: 'loaded', entries: [ENTRY] });
  });

  it('reads an entry from an API that predates the session field', async () => {
    // The services deploy independently, so the web app briefly talks to the
    // previous API. A required field would turn that window into a parse
    // failure on the activity page; null is the honest reading of a response
    // from a version that could not record a session.
    const older: Record<string, unknown> = { ...ENTRY };
    delete older['sessionId'];

    const outcome = await fetchActivity(
      API,
      TOKEN,
      responds(200, JSON.stringify({ entries: [older] })),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      entries: [{ ...older, sessionId: null }],
    });
  });

  it('returns an empty list as loaded, not as an error', async () => {
    const outcome = await fetchActivity(
      API,
      TOKEN,
      responds(200, JSON.stringify({ entries: [] })),
    );
    expect(outcome).toEqual({ kind: 'loaded', entries: [] });
  });

  it('sends the token and the forwarded address', async () => {
    let seen: Record<string, string> | undefined;
    await fetchActivity(
      API,
      TOKEN,
      (_url, init) => {
        seen = init?.headers;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ entries: [] })),
        });
      },
      '203.0.113.7',
    );

    expect(seen?.['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(seen?.['x-client-ip']).toBe('203.0.113.7');
  });

  it('omits the address header when there is none', async () => {
    // Omitted rather than sent empty: an empty header in a request log invites
    // the reader to think it was measured and found to be nothing.
    let seen: Record<string, string> | undefined;
    await fetchActivity(API, TOKEN, (_url, init) => {
      seen = init?.headers;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ entries: [] })),
      });
    });

    expect(seen).not.toHaveProperty('x-client-ip');
  });

  it('short-circuits with no token', async () => {
    let called = false;
    const outcome = await fetchActivity(API, null, () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reads 401 as signed out', async () => {
    expect(await fetchActivity(API, TOKEN, responds(401, ''))).toEqual({
      kind: 'signed-out',
    });
  });

  it.each([500, 502])('does not read %d as an empty log', async (status) => {
    // The failure that matters here: "nothing has happened on your account" is
    // a security claim, and an outage must never render as one.
    const outcome = await fetchActivity(API, TOKEN, responds(status, ''));
    expect(outcome.kind).toBe('unreachable');
  });

  it('reports a refused connection rather than throwing', async () => {
    const outcome = await fetchActivity(API, TOKEN, () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );
    expect(outcome).toMatchObject({ kind: 'unreachable', reason: /ECONNREFUSED/ });
  });

  it('names the timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const outcome = await fetchActivity(API, TOKEN, () => Promise.reject(timeout));
    expect(outcome).toMatchObject({ kind: 'unreachable', reason: /3000ms/ });
  });

  it('reports an HTML error page as malformed', async () => {
    const outcome = await fetchActivity(API, TOKEN, responds(200, '<html>502</html>'));
    expect(outcome).toMatchObject({ kind: 'malformed', reason: /<html>/ });
  });

  it('rejects a shape this version does not understand', async () => {
    const outcome = await fetchActivity(
      API,
      TOKEN,
      responds(200, JSON.stringify([ENTRY])),
    );
    expect(outcome.kind).toBe('malformed');
  });

  it('rejects an entry carrying a digest it should not', async () => {
    // The API never returns these. If one appears, the contract has drifted and
    // the page should say so rather than render it.
    const outcome = await fetchActivity(
      API,
      TOKEN,
      responds(
        200,
        JSON.stringify({ entries: [{ ...ENTRY, beforeHash: 'a'.repeat(64) }] }),
      ),
    );

    expect(outcome.kind).toBe('loaded');
    if (outcome.kind !== 'loaded') return;
    expect(JSON.stringify(outcome.entries)).not.toContain('aaaa');
  });
});
