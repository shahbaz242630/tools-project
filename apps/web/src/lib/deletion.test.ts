import { describe, expect, it } from 'vitest';
import { requestDeletion } from './deletion';
import type { FetchLike } from './deletion';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('requestDeletion', () => {
  it('reports a completed deletion', async () => {
    const outcome = await requestDeletion(
      API,
      TOKEN,
      responds(200, JSON.stringify({ outcome: 'deleted' })),
    );
    expect(outcome).toEqual({ kind: 'deleted' });
  });

  it('POSTs, because this is not a read', async () => {
    let method: string | undefined;
    await requestDeletion(API, TOKEN, (_url, init) => {
      method = init?.method;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ outcome: 'deleted' })),
      });
    });
    expect(method).toBe('POST');
  });

  it('sends the token and the forwarded address', async () => {
    let seen: Record<string, string> | undefined;
    await requestDeletion(
      API,
      TOKEN,
      (_url, init) => {
        seen = init?.headers;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ outcome: 'deleted' })),
        });
      },
      '203.0.113.7',
    );

    expect(seen?.['authorization']).toBe(`Bearer ${TOKEN}`);
    // Recorded against the deletion entry, which is retained for six years.
    expect(seen?.['x-client-ip']).toBe('203.0.113.7');
  });

  it('sends nothing without a token', async () => {
    let called = false;
    const outcome = await requestDeletion(API, null, () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reads 401 as signed out, which nothing was done under', async () => {
    expect(await requestDeletion(API, TOKEN, responds(401, ''))).toEqual({
      kind: 'signed-out',
    });
  });

  it.each([
    ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['a dropped connection', new Error('socket hang up')],
  ])('reports %s as uncertain, never as failed', async (_label, error) => {
    // The failure that matters most here, and it is the opposite of the profile
    // form's. A timeout on a POST is not evidence that nothing happened.
    // Telling somebody it failed invites a retry they may not be able to make —
    // by then they cannot authenticate.
    const outcome = await requestDeletion(API, TOKEN, () => Promise.reject(error));
    expect(outcome.kind).toBe('uncertain');
  });

  it.each([500, 502, 409])('reports %d as uncertain', async (status) => {
    const outcome = await requestDeletion(API, TOKEN, responds(status, ''));
    expect(outcome.kind).toBe('uncertain');
  });

  it('names the timeout budget, which is longer than a read’s', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const outcome = await requestDeletion(API, TOKEN, () => Promise.reject(timeout));
    // Giving up early on a write that is still running is how a caller ends up
    // uncertain about something that succeeded.
    expect(outcome).toMatchObject({ kind: 'uncertain', reason: /5000ms/ });
  });

  it('does not claim deletion when the body is not what this version expects', async () => {
    const outcome = await requestDeletion(
      API,
      TOKEN,
      responds(200, '<html>502</html>'),
    );
    expect(outcome.kind).toBe('uncertain');
  });

  it('does not claim deletion on an unexpected shape', async () => {
    const outcome = await requestDeletion(
      API,
      TOKEN,
      responds(200, JSON.stringify({ outcome: 'queued' })),
    );
    expect(outcome.kind).toBe('uncertain');
  });
});
