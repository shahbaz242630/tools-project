import { describe, expect, it } from 'vitest';
import { fetchFeatureFlags, setFeatureFlag } from './admin-feature-flags';
import type { FetchLike } from './admin-feature-flags';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const REASON = 'stopping publications while we investigate a report';
const KEY = 'listing.publication';

const FLAG = {
  key: KEY,
  label: 'Publishing listings',
  gates: 'Owners publishing a listing.',
  enabled: true,
  defaultEnabled: true,
  source: 'default',
  changedAt: null,
  changedById: null,
};

function responds(status: number, body = ''): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

/** Captures what was actually sent, so the request itself can be asserted. */
function capturing(status: number, body = '') {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return Promise.resolve({ status, text: () => Promise.resolve(body) });
  };
  return { calls, fetchImpl };
}

describe('fetchFeatureFlags', () => {
  it('returns the list', async () => {
    const outcome = await fetchFeatureFlags(
      API,
      TOKEN,
      responds(200, JSON.stringify({ flags: [FLAG] })),
    );

    expect(outcome).toEqual({ kind: 'loaded', value: [FLAG] });
  });

  it('is signed out without a token, without calling the API', async () => {
    let called = false;
    const outcome = await fetchFeatureFlags(API, null, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('never reads from a cache', async () => {
    // More important here than on any other admin read. A kill switch served
    // from a cache is one that appears not to have worked, and the response to
    // that during an incident is to throw it again.
    const { calls, fetchImpl } = capturing(200, JSON.stringify({ flags: [] }));
    await fetchFeatureFlags(API, TOKEN, fetchImpl);

    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('reports a mis-shaped list as malformed rather than rendering it', async () => {
    // Zod strips unknown keys, so a missing *required* field is what proves the
    // parse runs at all.
    const outcome = await fetchFeatureFlags(
      API,
      TOKEN,
      responds(200, JSON.stringify({ flags: [{ key: KEY }] })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('distinguishes forbidden from signed out', async () => {
    // The page says different things for each: one is "sign in again", the
    // other is "your second factor is too old", and telling somebody the wrong
    // one sends them round a loop that cannot fix it.
    expect((await fetchFeatureFlags(API, TOKEN, responds(403))).kind).toBe('forbidden');
    expect((await fetchFeatureFlags(API, TOKEN, responds(401))).kind).toBe(
      'signed-out',
    );
  });

  it('reports an unexpected status as unreachable rather than throwing', async () => {
    const outcome = await fetchFeatureFlags(API, TOKEN, responds(500));

    expect(outcome).toEqual({ kind: 'unreachable', reason: 'API answered 500' });
  });
});

describe('setFeatureFlag', () => {
  it('PUTs the new value with the reason in the query string', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(FLAG));
    await setFeatureFlag(API, TOKEN, KEY, false, REASON, fetchImpl);

    const [call] = calls;
    expect(call?.init?.method).toBe('PUT');
    expect(call?.init?.body).toBe(JSON.stringify({ enabled: false }));

    // Asserted by decoding rather than by comparing the encoded string.
    // `URLSearchParams` writes a space as `+` and `encodeURIComponent` writes
    // `%20`; both are correct and a test that pinned one of them would be
    // asserting an implementation detail of the URL builder. What has to be
    // true is that the reason arrives with its spaces — a reason stored as
    // `stopping+publications` is one somebody reads in an incident review.
    const url = new URL(call?.url ?? '');
    expect(url.pathname).toBe(`/admin/feature-flags/${KEY}`);
    expect(url.searchParams.get('reason')).toBe(REASON);
  });

  it('encodes a key containing a dot without mangling it', async () => {
    // `listing.publication` is the shape every key has, and a path segment that
    // silently lost its dot would 404 in a way that reads like the flag having
    // been removed by a deploy.
    const { calls, fetchImpl } = capturing(200, JSON.stringify(FLAG));
    await setFeatureFlag(API, TOKEN, KEY, true, REASON, fetchImpl);

    expect(calls[0]?.url).toContain('/admin/feature-flags/listing.publication?');
  });

  it('is signed out without a token, without calling the API', async () => {
    let called = false;
    const outcome = await setFeatureFlag(API, null, KEY, false, REASON, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reports a key this build does not declare as not-found', async () => {
    const outcome = await setFeatureFlag(API, TOKEN, KEY, false, REASON, responds(404));

    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('carries the API’s own issues through a 400', async () => {
    const outcome = await setFeatureFlag(
      API,
      TOKEN,
      KEY,
      false,
      '',
      responds(400, JSON.stringify({ issues: ['The reason is too short'] })),
    );

    expect(outcome).toEqual({ kind: 'invalid', issues: ['The reason is too short'] });
  });

  it('falls back to a usable message when a 400 carries no issues', async () => {
    const outcome = await setFeatureFlag(API, TOKEN, KEY, false, REASON, responds(400));

    // No body means nothing was lost, so the fallback stands on its own.
    expect(outcome).toEqual({ kind: 'invalid', issues: ['The request was rejected'] });
  });

  it('keeps the fallback and still reports a body it could not read', async () => {
    const outcome = await setFeatureFlag(
      API,
      TOKEN,
      KEY,
      false,
      REASON,
      responds(400, '<html>502 Bad Gateway</html>'),
    );

    expect(outcome.kind).toBe('invalid');
    const [issue] = outcome.kind === 'invalid' ? outcome.issues : [];
    expect(issue).toContain('The request was rejected');
    // The whole point: an administrator throwing a kill switch during an
    // incident, told only "the request was rejected", had no way to see that
    // something in front of the API had answered instead of the API.
    expect(issue).toContain('502 Bad Gateway');
  });

  it('uses the API’s message as the issue when it sent no issues array', async () => {
    const outcome = await setFeatureFlag(
      API,
      TOKEN,
      KEY,
      false,
      '',
      responds(400, JSON.stringify({ message: 'A reason is required' })),
    );

    expect(outcome).toEqual({ kind: 'invalid', issues: ['A reason is required'] });
  });
});
