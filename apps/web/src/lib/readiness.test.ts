import { describe, expect, it, vi } from 'vitest';
import { fetchReadiness, READINESS_TIMEOUT_MS } from './readiness';
import type { FetchLike } from './readiness';

const respondWith = (body: string): FetchLike =>
  vi.fn(async () => ({ text: async () => body }));

const failWith = (error: unknown): FetchLike =>
  vi.fn(async () => {
    throw error;
  });

const API = 'http://api:3000';

describe('fetchReadiness', () => {
  it('asks the API at the path the contract defines', async () => {
    const fetchImpl = respondWith('{"status":"ready","checks":{}}');
    await fetchReadiness(API, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api:3000/ready',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('builds the URL correctly when the base has a trailing path', async () => {
    const fetchImpl = respondWith('{"status":"ready","checks":{}}');
    await fetchReadiness('http://api:3000/', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('http://api:3000/ready', expect.anything());
  });

  it('reports ready', async () => {
    const outcome = await fetchReadiness(
      API,
      respondWith('{"status":"ready","checks":{"postgres":"ok","redis":"ok"}}'),
    );
    expect(outcome).toEqual({
      kind: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('reports not_ready and keeps the per-dependency detail', async () => {
    // The API answers 503 here. This must not be treated as a failed request —
    // the body naming the broken dependency is the useful part.
    const outcome = await fetchReadiness(
      API,
      respondWith('{"status":"not_ready","checks":{"postgres":"failed","redis":"ok"}}'),
    );
    expect(outcome).toEqual({
      kind: 'not_ready',
      checks: { postgres: 'failed', redis: 'ok' },
    });
  });

  it('reports unreachable when the connection is refused', async () => {
    const outcome = await fetchReadiness(
      API,
      failWith(new Error('connect ECONNREFUSED 127.0.0.1:3000')),
    );
    expect(outcome).toMatchObject({ kind: 'unreachable' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('ECONNREFUSED'));
  });

  it('explains a timeout in terms of the budget, not the raw error', async () => {
    const timeout = Object.assign(new Error('The operation was aborted.'), {
      name: 'TimeoutError',
    });
    const outcome = await fetchReadiness(API, failWith(timeout));
    expect(outcome).toEqual({
      kind: 'unreachable',
      reason: `no response within ${READINESS_TIMEOUT_MS}ms`,
    });
  });

  it('survives something being thrown that is not an Error', async () => {
    // Rare but real: a rejected promise carrying a string, or a DOMException in
    // some runtimes. Stringifying rather than assuming `.message` keeps the
    // reason readable instead of "undefined".
    const outcome = await fetchReadiness(API, failWith('socket hang up'));
    expect(outcome).toEqual({ kind: 'unreachable', reason: 'socket hang up' });
  });

  it('reports malformed when a proxy returns an HTML error page', async () => {
    // The realistic case: the ingress answers 502 with HTML because the API
    // container is being replaced. Without this branch, JSON.parse throws
    // inside a server component and the whole page 500s.
    const outcome = await fetchReadiness(
      API,
      respondWith('<html><body>502 Bad Gateway</body></html>'),
    );
    expect(outcome).toMatchObject({ kind: 'malformed' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('expected JSON'));
  });

  it('reports malformed on an empty body without saying "expected JSON, got "', async () => {
    const outcome = await fetchReadiness(API, respondWith('   '));
    expect(outcome).toHaveProperty(
      'reason',
      expect.stringContaining('(empty response)'),
    );
  });

  it('truncates a very long non-JSON body', async () => {
    const outcome = await fetchReadiness(API, respondWith('x'.repeat(5000)));
    expect((outcome as { reason: string }).reason.length).toBeLessThan(200);
  });

  it('reports malformed when the API answers valid JSON of the wrong shape', async () => {
    // A version skew during a deploy: web is new, API is old. This must name
    // the mismatch rather than rendering undefined.
    const outcome = await fetchReadiness(
      API,
      respondWith('{"status":"ready","checks":{"postgres":"fine"}}'),
    );
    expect(outcome).toMatchObject({ kind: 'malformed' });
    expect(outcome).toHaveProperty(
      'reason',
      expect.stringContaining('checks.postgres'),
    );
  });

  it('accepts a dependency it has never heard of', async () => {
    const outcome = await fetchReadiness(
      API,
      respondWith('{"status":"ready","checks":{"postgres":"ok","s3":"ok"}}'),
    );
    expect(outcome).toMatchObject({ kind: 'ready' });
  });
});
