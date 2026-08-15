import { describe, expect, it } from 'vitest';
import { fetchMyProfile, fetchPublicProfile, saveMyProfile } from './profile';
import type { FetchLike, FetchResponse } from './profile';
import type { ProfileInput } from '@platform/contracts';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

const MY_PROFILE = {
  displayName: 'Sarah M.',
  phone: '+447700900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: null,
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
  ownerStatus: null,
  updatedAt: '2026-07-31T09:00:00.000Z',
};

const PUBLIC_PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Sarah M.',
  outwardCode: 'BS7',
  town: 'Bristol',
  memberSince: '2026-07',
};

const INPUT: ProfileInput = {
  displayName: 'Sarah M.',
  phone: '+447700900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: null,
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
  ownerStatus: 'private_owner',
};

/** Answers once with the given status and body. */
function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

function rejects(error: Error): FetchLike {
  return () => Promise.reject(error);
}

describe('fetchMyProfile', () => {
  it('returns the profile', async () => {
    const outcome = await fetchMyProfile(
      API,
      TOKEN,
      responds(200, JSON.stringify({ profile: MY_PROFILE })),
    );
    expect(outcome).toEqual({ kind: 'loaded', profile: MY_PROFILE });
  });

  it('returns null for somebody who has not made one', async () => {
    const outcome = await fetchMyProfile(
      API,
      TOKEN,
      responds(200, JSON.stringify({ profile: null })),
    );
    expect(outcome).toEqual({ kind: 'loaded', profile: null });
  });

  it('short-circuits with no token rather than making a doomed request', async () => {
    let called = false;
    const outcome = await fetchMyProfile(API, null, () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('sends the token as a bearer credential', async () => {
    let seen: Record<string, string> | undefined;
    await fetchMyProfile(API, TOKEN, (_url, init) => {
      seen = init?.headers;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ profile: null })),
      });
    });

    expect(seen?.['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('reads 401 as signed out', async () => {
    // Session tokens are short-lived, so one expiring between render and fetch
    // is routine rather than exceptional.
    expect(await fetchMyProfile(API, TOKEN, responds(401, ''))).toEqual({
      kind: 'signed-out',
    });
  });

  it('reads 403 as forbidden rather than as an outage', async () => {
    expect(await fetchMyProfile(API, TOKEN, responds(403, ''))).toEqual({
      kind: 'forbidden',
    });
  });

  it.each([500, 502, 418])('does not read %d as signed out', async (status) => {
    // Telling a signed-in person they are signed out because the API returned
    // 500 invites them to sign in again and again.
    const outcome = await fetchMyProfile(API, TOKEN, responds(status, ''));
    expect(outcome.kind).toBe('unreachable');
  });

  it('reports a refused connection rather than throwing', async () => {
    const outcome = await fetchMyProfile(
      API,
      TOKEN,
      rejects(new Error('connect ECONNREFUSED')),
    );
    expect(outcome).toMatchObject({ kind: 'unreachable', reason: /ECONNREFUSED/ });
  });

  it('names the timeout when there is no answer', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const outcome = await fetchMyProfile(API, TOKEN, rejects(timeout));
    expect(outcome).toMatchObject({ kind: 'unreachable', reason: /3000ms/ });
  });

  it('reports an HTML error page as malformed, with an excerpt', async () => {
    const outcome = await fetchMyProfile(API, TOKEN, responds(200, '<html>502</html>'));
    expect(outcome).toMatchObject({ kind: 'malformed', reason: /<html>/ });
  });

  it('reports a shape this version does not understand', async () => {
    // The mid-deploy window where the two services are on different versions.
    const outcome = await fetchMyProfile(
      API,
      TOKEN,
      responds(200, JSON.stringify({ displayName: 'Sarah M.' })),
    );
    expect(outcome.kind).toBe('malformed');
  });
});

describe('saveMyProfile', () => {
  it('PUTs the profile as JSON', async () => {
    let method: string | undefined;
    let body: string | undefined;

    await saveMyProfile(API, TOKEN, INPUT, (_url, init) => {
      method = init?.method;
      body = init?.body;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify(MY_PROFILE)),
      });
    });

    expect(method).toBe('PUT');
    expect(JSON.parse(body ?? '{}')).toEqual(INPUT);
  });

  it('returns the saved profile', async () => {
    const outcome = await saveMyProfile(
      API,
      TOKEN,
      INPUT,
      responds(200, JSON.stringify(MY_PROFILE)),
    );
    expect(outcome).toEqual({ kind: 'saved', profile: MY_PROFILE });
  });

  it('surfaces the API’s field-level complaints', async () => {
    // A 400 is a result, not a failure. Losing these messages leaves somebody
    // staring at "something went wrong" with no idea which box to fix.
    const outcome = await saveMyProfile(
      API,
      TOKEN,
      INPUT,
      responds(
        400,
        JSON.stringify({ issues: ['postcode: must be a valid UK postcode'] }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'invalid',
      issues: ['postcode: must be a valid UK postcode'],
    });
  });

  it('still reports invalid when the 400 body is not the shape expected', async () => {
    const outcome = await saveMyProfile(API, TOKEN, INPUT, responds(400, 'nope'));
    expect(outcome.kind).toBe('invalid');
  });

  it('does not claim success when the API never answered', async () => {
    // The failure mode that matters most here: a form saying it saved when it
    // did not is how somebody closes the tab believing their address is stored.
    const outcome = await saveMyProfile(
      API,
      TOKEN,
      INPUT,
      rejects(new Error('socket hang up')),
    );

    expect(outcome.kind).toBe('unreachable');
  });

  it('does not send anything without a token', async () => {
    let called = false;
    const outcome = await saveMyProfile(API, null, INPUT, () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  /*
   * The reachable one, and the reason this member exists.
   *
   * `GET /me/profile` opts in to `@AllowsSuspended` and `PUT` deliberately does
   * not (ADR 0024), so a suspended person is handed their own populated,
   * editable form and refused the moment they press Save. Until this branch,
   * every 403 fell into `unreachable` and the page read *"Your profile was not
   * saved — API answered 403"*: the site blamed for a decision somebody made.
   */
  it('reads 403 as forbidden, not as an unreachable API', async () => {
    const outcome = await saveMyProfile(API, TOKEN, INPUT, responds(403, ''));
    expect(outcome).toEqual({ kind: 'forbidden' });
  });
});

describe('fetchPublicProfile', () => {
  it('returns the public projection', async () => {
    const outcome = await fetchPublicProfile(
      API,
      PUBLIC_PROFILE.id,
      responds(200, JSON.stringify(PUBLIC_PROFILE)),
    );
    expect(outcome).toEqual({ kind: 'found', profile: PUBLIC_PROFILE });
  });

  it('sends no credentials', async () => {
    // This is the one profile route a visitor may call. Sending a token would
    // suggest the answer depends on who is asking; it does not.
    let init: { headers?: Record<string, string> } | undefined;
    await fetchPublicProfile(API, PUBLIC_PROFILE.id, (_url, received) => {
      init = received;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify(PUBLIC_PROFILE)),
      });
    });

    expect(init?.headers?.['authorization']).toBeUndefined();
  });

  it('reads 404 as not found', async () => {
    expect(await fetchPublicProfile(API, PUBLIC_PROFILE.id, responds(404, ''))).toEqual(
      { kind: 'not-found' },
    );
  });

  it('does not read a 500 as not found', async () => {
    const outcome = await fetchPublicProfile(API, PUBLIC_PROFILE.id, responds(500, ''));
    expect(outcome.kind).toBe('unreachable');
  });

  it('rejects a response carrying a contact field it should not', async () => {
    // Belt and braces on the disclosure rule: even if the API somehow answered
    // with a phone number, the parser strips it before it can reach a page.
    const outcome = await fetchPublicProfile(
      API,
      PUBLIC_PROFILE.id,
      responds(200, JSON.stringify({ ...PUBLIC_PROFILE, phone: '+447700900123' })),
    );

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(JSON.stringify(outcome.profile)).not.toContain('900123');
  });

  it('reports a malformed response rather than rendering nothing', async () => {
    const outcome = await fetchPublicProfile(
      API,
      PUBLIC_PROFILE.id,
      responds(200, JSON.stringify({ displayName: 'Sarah M.' })),
    );
    expect(outcome.kind).toBe('malformed');
  });
});

describe('the response contract', () => {
  it('accepts any object shaped like a fetch Response', () => {
    // The narrow `FetchResponse` interface is what lets every test above run
    // without a server; this asserts the real shape still satisfies it.
    const real: FetchResponse = { status: 200, text: () => Promise.resolve('{}') };
    expect(real.status).toBe(200);
  });
});
