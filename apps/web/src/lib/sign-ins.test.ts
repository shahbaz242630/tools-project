import { describe, expect, it } from 'vitest';
import { fetchSignIns } from './sign-ins';
import type { FetchLike } from './sign-ins';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  event: 'started',
  sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
  occurredAt: '2026-07-30T10:53:19.422Z',
  ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
  browserName: 'Edge',
  browserVersion: '150.0.0.0',
  deviceType: 'Windows',
  isMobile: false,
};

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('fetchSignIns', () => {
  it('returns the entries', async () => {
    const outcome = await fetchSignIns(
      API,
      TOKEN,
      responds(200, JSON.stringify({ entries: [ENTRY] })),
    );
    expect(outcome).toEqual({ kind: 'loaded', entries: [ENTRY] });
  });

  it('distinguishes an empty history from a failure', async () => {
    // The distinction the whole page rests on. "Nobody else signed in" and "we
    // could not find out" must never render the same.
    const empty = await fetchSignIns(API, TOKEN, responds(200, '{"entries":[]}'));
    expect(empty).toEqual({ kind: 'loaded', entries: [] });

    const failed = await fetchSignIns(API, TOKEN, responds(500, 'boom'));
    expect(failed.kind).toBe('unreachable');
  });

  it('reports a missing token as signed out without calling the API', async () => {
    let called = false;
    const outcome = await fetchSignIns(API, null, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('{}') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('treats an empty-string token as signed out', async () => {
    expect(await fetchSignIns(API, '', responds(200, '{}'))).toEqual({
      kind: 'signed-out',
    });
  });

  it('reports 401 as signed out', async () => {
    expect(await fetchSignIns(API, TOKEN, responds(401, ''))).toEqual({
      kind: 'signed-out',
    });
  });

  it('does not report 403 as signed out', async () => {
    // A suspended account reaches this route — it opts in — so a 403 means
    // something else went wrong. Reporting it as "sign in again" would send
    // somebody round a loop that cannot end.
    const outcome = await fetchSignIns(API, TOKEN, responds(403, ''));
    expect(outcome.kind).toBe('unreachable');
  });

  it('reports a non-JSON body as malformed, with what it got', async () => {
    const outcome = await fetchSignIns(API, TOKEN, responds(200, '<html>502</html>'));
    expect(outcome).toMatchObject({ kind: 'malformed' });
    expect(outcome.kind === 'malformed' && outcome.reason).toContain('<html>');
  });

  it('reports an entry that breaks the contract as malformed', async () => {
    const outcome = await fetchSignIns(
      API,
      TOKEN,
      responds(200, JSON.stringify({ entries: [{ ...ENTRY, event: 'banana' }] })),
    );
    expect(outcome.kind).toBe('malformed');
  });

  it('reports a transport failure as unreachable', async () => {
    const outcome = await fetchSignIns(API, TOKEN, () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    expect(outcome).toEqual({ kind: 'unreachable', reason: 'ECONNREFUSED' });
  });

  it('sends the bearer token and forwards the client address', async () => {
    let seen: Record<string, string> | undefined;
    await fetchSignIns(
      API,
      TOKEN,
      (_url, init) => {
        seen = init?.headers;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve('{"entries":[]}'),
        });
      },
      '203.0.113.7',
    );

    expect(seen).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-client-ip': '203.0.113.7',
    });
  });

  it('omits the address header when there is none, rather than sending empty', async () => {
    // An empty header would reach an `inet` column as an invalid value. The
    // API validates it too, but not sending it is the honest signal.
    let seen: Record<string, string> | undefined;
    await fetchSignIns(API, TOKEN, (_url, init) => {
      seen = init?.headers;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve('{"entries":[]}'),
      });
    });

    expect(seen).not.toHaveProperty('x-client-ip');
  });

  it('calls the sign-ins path', async () => {
    let seen = '';
    await fetchSignIns(API, TOKEN, (url) => {
      seen = url;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve('{"entries":[]}'),
      });
    });

    expect(seen).toBe('http://api.internal:3001/me/sign-ins');
  });
});
