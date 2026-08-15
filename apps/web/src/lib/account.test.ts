import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_TIMEOUT_MS, fetchAccount } from './account';
import type { FetchLike } from './account';

const BASE = 'http://api:3000';

const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  role: 'USER',
  suspendedAt: null,
  suspensionReason: null,
  adminMfaBypassed: false,
};

const answering = (status: number, body: unknown): FetchLike =>
  vi.fn(() =>
    Promise.resolve({
      status,
      text: () =>
        Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    }),
  );

describe('fetchAccount', () => {
  it('returns the account when the API answers', async () => {
    const outcome = await fetchAccount(BASE, 'token', answering(200, ACCOUNT));
    expect(outcome).toEqual({ kind: 'signed-in', account: ACCOUNT });
  });

  it('reads an account from an API that predates suspension', async () => {
    // The services deploy independently, so the web app is briefly talking to
    // the previous API. An API that could not suspend anybody has nobody
    // suspended, so defaulting both fields to null is the honest reading — and
    // a required field would have made the skew window a broken account page.
    const older: Record<string, unknown> = { ...ACCOUNT };
    delete older['suspendedAt'];
    delete older['suspensionReason'];

    const outcome = await fetchAccount(BASE, 'token', answering(200, older));
    expect(outcome).toEqual({ kind: 'signed-in', account: ACCOUNT });
  });

  it('reads a silent API as enforcing the second factor, not bypassing it', async () => {
    // The same deploy-skew argument, on a flag where the direction matters:
    // an API that does not mention `adminMfaBypassed` is one that predates it
    // and therefore is not bypassing anything. Defaulting the other way would
    // put the warning banner on a perfectly enforced admin surface, which
    // teaches people to ignore it (ADR 0030).
    const older: Record<string, unknown> = { ...ACCOUNT };
    delete older['adminMfaBypassed'];

    const outcome = await fetchAccount(BASE, 'token', answering(200, older));
    expect(outcome).toEqual({ kind: 'signed-in', account: ACCOUNT });
  });

  it('sends the token as a bearer credential', async () => {
    const fetchImpl = answering(200, ACCOUNT);
    await fetchAccount(BASE, 'the-token', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api:3000/me',
      expect.objectContaining({
        headers: { authorization: 'Bearer the-token' },
      }),
    );
  });

  it.each([[null], ['']])(
    'reports signed out for %j without calling the API',
    async (token) => {
      // Signed out is a normal state. A round trip to be told so is wasted on
      // every anonymous page view.
      const fetchImpl = answering(200, ACCOUNT);
      expect(await fetchAccount(BASE, token, fetchImpl)).toEqual({
        kind: 'signed-out',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('reports signed out when the API rejects the token', async () => {
    // Tokens are issued with a 60-second lifetime, so one expiring between
    // render and fetch is routine rather than exceptional.
    expect(await fetchAccount(BASE, 'stale', answering(401, ''))).toEqual({
      kind: 'signed-out',
    });
  });

  it('reports 403 as a refusal rather than as an outage', async () => {
    // `/me` opts in to `@AllowsSuspended`, so nothing produces one today. The
    // branch exists because the alternative was a client that would answer the
    // first route which does not opt in with "the service did not answer" —
    // which is how the profile form came to blame the site for an
    // administrator's decision.
    expect(await fetchAccount(BASE, 'token', answering(403, ''))).toEqual({
      kind: 'forbidden',
    });
  });

  it.each([[500], [502], [418]])(
    'does not report signed out when the API answers %i',
    async (status) => {
      // The failure this prevents: telling a signed-in person they are signed
      // out because the API is broken, which invites them to sign in over and
      // over against a service that cannot answer.
      const outcome = await fetchAccount(BASE, 'token', answering(status, ''));
      expect(outcome.kind).toBe('unreachable');
    },
  );

  it('reports unreachable when the request fails', async () => {
    const outcome = await fetchAccount(BASE, 'token', () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );
    expect(outcome).toEqual({ kind: 'unreachable', reason: 'connect ECONNREFUSED' });
  });

  it('says how long it waited when the request times out', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });

    const outcome = await fetchAccount(BASE, 'token', () => Promise.reject(timeout));
    expect(outcome).toEqual({
      kind: 'unreachable',
      reason: `no response within ${ACCOUNT_TIMEOUT_MS}ms`,
    });
  });

  it('bounds the request', async () => {
    // Without a signal a page render blocks for as long as the API cares to
    // take, which a reader experiences as a page that never loads.
    const fetchImpl = answering(200, ACCOUNT);
    await fetchAccount(BASE, 'token', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports malformed when the body is not JSON', async () => {
    // Almost always a proxy error page rather than the API.
    const outcome = await fetchAccount(
      BASE,
      'token',
      answering(200, '<html>502</html>'),
    );
    expect(outcome.kind).toBe('malformed');
    expect(outcome).toMatchObject({
      reason: expect.stringContaining('<html>502</html>'),
    });
  });

  it('reports malformed rather than trusting a wrong shape', async () => {
    // The window that makes this real: web and api deploy independently, so a
    // new web app can be talking to the previous API. Trusting the shape would
    // render a signed-in page belonging to nobody.
    const outcome = await fetchAccount(
      BASE,
      'token',
      answering(200, { id: 'not-a-uuid' }),
    );
    expect(outcome.kind).toBe('malformed');
  });

  it('names the offending field when the shape is wrong', async () => {
    const outcome = await fetchAccount(
      BASE,
      'token',
      answering(200, { ...ACCOUNT, email: 'not-an-email' }),
    );
    expect(outcome).toMatchObject({ reason: expect.stringContaining('email') });
  });

  it('rejects an unknown role rather than rendering it', async () => {
    // A role the web app does not know about must not be shown as though it
    // were understood — the next thing built on it is a permissions decision.
    const outcome = await fetchAccount(
      BASE,
      'token',
      answering(200, { ...ACCOUNT, role: 'SUPERUSER' }),
    );
    expect(outcome.kind).toBe('malformed');
  });
});

describe('fetchAccount — awkward failures', () => {
  it('describes a rejection that is not an Error', async () => {
    // `fetch` implementations and polyfills do reject with plain values. An
    // unguarded `error.message` here would throw inside the error handler.
    const outcome = await fetchAccount(BASE, 'token', () =>
      Promise.reject('socket hang up'),
    );
    expect(outcome).toEqual({ kind: 'unreachable', reason: 'socket hang up' });
  });

  it('survives a body that fails while being read', async () => {
    // A connection dropped mid-response resolves the request and then fails the
    // body. Unhandled, that surfaces as an unhandled rejection during render.
    const outcome = await fetchAccount(BASE, 'token', () =>
      Promise.resolve({
        status: 200,
        text: () => Promise.reject(new Error('aborted mid-body')),
      }),
    );
    expect(outcome).toEqual({ kind: 'unreachable', reason: 'aborted mid-body' });
  });
});
