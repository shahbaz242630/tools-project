import { describe, expect, it } from 'vitest';
import { moderateListing } from './admin-listings';
import type { FetchLike } from './admin-listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const LISTING = '3f1a9d2c-0000-4000-8000-000000000001';
const REASON = 'Reported as a prohibited item — checking with the owner';

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

const DECIDED = JSON.stringify({ moderationState: 'UNDER_REVIEW' });

describe('moderateListing', () => {
  it('returns the decision the API recorded', async () => {
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'UNDER_REVIEW',
      REASON,
      responds(200, DECIDED),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      value: { moderationState: 'UNDER_REVIEW' },
    });
  });

  it('reads the state back rather than echoing what it sent', async () => {
    // The page renders this value, so it has to be the API's answer and not the
    // form's input. If the two ever disagree — a state renamed, a decision
    // recorded differently — the interface must show what happened.
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'REJECTED',
      REASON,
      responds(200, JSON.stringify({ moderationState: 'APPROVED' })),
    );

    expect(outcome).toEqual({ kind: 'loaded', value: { moderationState: 'APPROVED' } });
  });

  it('PUTs to the moderation path with the decision', async () => {
    const { calls, fetchImpl } = capturing(200, DECIDED);
    await moderateListing(API, TOKEN, LISTING, 'UNDER_REVIEW', REASON, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/admin/listings/${LISTING}/moderation`);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({
      state: 'UNDER_REVIEW',
      reason: REASON,
    });
  });

  it('sends a null reason explicitly when reinstating', async () => {
    // Rather than omitting the field. Both work — the schema treats blank as
    // absent — and being explicit makes a reinstatement visibly a decision with
    // no reason attached rather than a request that forgot one.
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ moderationState: 'APPROVED' }),
    );
    await moderateListing(API, TOKEN, LISTING, 'APPROVED', null, fetchImpl);

    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({
      state: 'APPROVED',
      reason: null,
    });
  });

  it('encodes the id, so a malformed one cannot reshape the path', async () => {
    const { calls, fetchImpl } = capturing(404);
    await moderateListing(API, TOKEN, '../users/me', 'APPROVED', null, fetchImpl);

    // The separators are what matter: encoded, they stay one path segment and
    // the request goes to a listing id that does not exist (404). Unencoded,
    // this would have been a `PUT` at `/admin/users/me/moderation`.
    expect(calls[0]?.url).toBe(`${API}/admin/listings/..%2Fusers%2Fme/moderation`);
  });

  it('never reads from a cache', async () => {
    const { calls, fetchImpl } = capturing(200, DECIDED);
    await moderateListing(API, TOKEN, LISTING, 'UNDER_REVIEW', REASON, fetchImpl);

    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('forwards the client IP when it has one', async () => {
    // The audit entry the API writes names the administrator and where they
    // acted from, and the API never sees a browser (ADR 0017).
    const { calls, fetchImpl } = capturing(200, DECIDED);
    await moderateListing(
      API,
      TOKEN,
      LISTING,
      'UNDER_REVIEW',
      REASON,
      fetchImpl,
      '203.0.113.4',
    );

    expect(calls[0]?.init?.headers?.['x-client-ip']).toBe('203.0.113.4');
  });

  it('is signed out without a token, without calling the API', async () => {
    let called = false;
    const outcome = await moderateListing(API, null, LISTING, 'APPROVED', null, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reports a refused role separately from an expired session', async () => {
    // The remedy differs: one needs signing in again, the other needs a second
    // factor or a role this account does not hold.
    expect(
      (await moderateListing(API, TOKEN, LISTING, 'APPROVED', null, responds(403)))
        .kind,
    ).toBe('forbidden');
    expect(
      (await moderateListing(API, TOKEN, LISTING, 'APPROVED', null, responds(401)))
        .kind,
    ).toBe('signed-out');
  });

  it('reports no such listing', async () => {
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'APPROVED',
      null,
      responds(404),
    );

    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('carries the API’s own issues out of a 400', async () => {
    // Both of this route's 400s carry them — a malformed decision from the
    // contract parser, and a hiding state with no reason from the service — and
    // the API is the only thing that knows which happened.
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'REJECTED',
      null,
      responds(400, JSON.stringify({ issues: ['reason: A reason is required'] })),
    );

    expect(outcome).toEqual({
      kind: 'invalid',
      issues: ['reason: A reason is required'],
    });
  });

  it('still says the decision was rejected when the 400 body is unreadable', async () => {
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'REJECTED',
      null,
      responds(400, 'not json'),
    );

    expect(outcome).toEqual({ kind: 'invalid', issues: ['The decision was rejected'] });
  });

  it('reports a response carrying the listing as malformed rather than reading it', async () => {
    /*
     * The disclosure guard, at the layer that would receive it.
     *
     * The route answers with the decision alone because `OwnerListing` carries
     * the collection address, and §8.4.1 does not disclose that to a moderator.
     * Reading `moderationState` off an unvalidated body would accept an echoed
     * record silently.
     */
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'REJECTED',
      REASON,
      responds(
        200,
        JSON.stringify({
          moderationState: 'REJECTED',
          collectionLocation: { postcode: 'BS7 8AA' },
        }),
      ),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports an unknown state in the response as malformed', async () => {
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'REJECTED',
      REASON,
      responds(200, JSON.stringify({ moderationState: 'HIDDEN' })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports a server error as unreachable, naming the status', async () => {
    const outcome = await moderateListing(
      API,
      TOKEN,
      LISTING,
      'APPROVED',
      null,
      responds(500),
    );

    expect(outcome).toEqual({ kind: 'unreachable', reason: 'API answered 500' });
  });

  it('reports a transport failure as unreachable', async () => {
    const outcome = await moderateListing(API, TOKEN, LISTING, 'APPROVED', null, () =>
      Promise.reject(new Error('socket hang up')),
    );

    expect(outcome).toEqual({ kind: 'unreachable', reason: 'socket hang up' });
  });

  it('names the timeout rather than reporting a bare abort', async () => {
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';

    const outcome = await moderateListing(API, TOKEN, LISTING, 'APPROVED', null, () =>
      Promise.reject(timeout),
    );

    expect(outcome).toEqual({
      kind: 'unreachable',
      reason: 'no response within 5000ms',
    });
  });
});
