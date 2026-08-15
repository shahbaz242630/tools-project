/**
 * One id per inbound request, on every outbound call.
 *
 * Two things are pinned here and they fail in different ways. The first is the
 * primitive: an inbound id is continued, an absent one is minted **once**, and a
 * forged one is refused. The second is the wiring, and it is the one that rots —
 * a new API client added to `lib/` without the header compiles, passes its own
 * tests, and silently starts a trace that ends at the web app. So every client
 * in the directory is called here, and the assertion is the same for all of
 * them.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * Stands in for Next's request store.
 *
 * **Returning the same object from every call is the fidelity that matters**,
 * not a convenience: that is exactly what Next does — `headers()` resolves to
 * `workUnitStore.headers`, one object for the life of the request — and it is
 * the property the per-request memoization is built on. A mock that handed back
 * a fresh object each time would model a different framework and would let a
 * per-call implementation pass.
 *
 * **A bare `get` rather than a real `Headers`**, for one reason: `Headers`
 * refuses to hold a value containing a newline, and a value containing a newline
 * is precisely the forged id worth testing against. Next's own type here is
 * `ReadonlyHeaders`, not `Headers`, so nothing is being pretended at.
 */
const store = vi.hoisted(() => ({
  values: {} as Record<string, string>,
  /** Set when the caller is outside a request scope, which is what Next does. */
  absent: false,
  bag: {} as { get: (name: string) => string | null },
}));

vi.mock('next/headers', () => ({
  headers: () =>
    store.absent
      ? Promise.reject(new Error('`headers` was called outside a request scope.'))
      : Promise.resolve(store.bag),
}));

import {
  CORRELATION_HEADER,
  correlationHeaders,
  currentCorrelationId,
} from './correlation';

import { fetchAccount } from './account';
import { fetchActivity } from './activity';
import { fetchAdminActivity } from './admin-activity';
import { fetchPendingApprovals } from './admin-approvals';
import { fetchCategories } from './admin-categories';
import { fetchFeatureFlags } from './admin-feature-flags';
import { moderateListing } from './admin-listings';
import { fetchAdminUser } from './admin-user';
import { forwardIdentityEvent } from './clerk-webhook';
import { fetchDataExport } from './data-export';
import { requestDeletion } from './deletion';
import { fetchOwnedListings, fetchPublicListing } from './listings';
import { fetchMyProfile, fetchPublicProfile, saveMyProfile } from './profile';
import { fetchReadiness } from './readiness';
import { fetchSignIns } from './sign-ins';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

/** A new inbound request, which means a new header bag — as it does in Next. */
function requestArrives(inbound?: string): void {
  store.absent = false;
  store.values = inbound === undefined ? {} : { [CORRELATION_HEADER]: inbound };
  const values = store.values;
  store.bag = { get: (name) => values[name.toLowerCase()] ?? null };
}

describe('currentCorrelationId', () => {
  it('continues a trace something in front of us already started', async () => {
    requestArrives('edge-abc123');
    expect(await currentCorrelationId()).toBe('edge-abc123');
  });

  it('gives every call in one request the same id', async () => {
    requestArrives();

    const [first, second, third] = await Promise.all([
      currentCorrelationId(),
      currentCorrelationId(),
      currentCorrelationId(),
    ]);

    // The defect, stated as an assertion: one page render fanning out into
    // three calls must produce one trace, not three.
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toMatch(/^[A-Za-z0-9-]{36}$/);
  });

  it('does not carry an id from one request into the next', async () => {
    requestArrives();
    const first = await currentCorrelationId();

    requestArrives();
    expect(await currentCorrelationId()).not.toBe(first);
  });

  it.each([
    ['a newline, which would forge a log entry', 'abc\ninjected level=error'],
    ['a space', 'abc def'],
    ['punctuation a log query would treat as syntax', 'abc"def'],
    ['nothing at all', '   '],
    ['more than 128 characters', 'a'.repeat(129)],
  ])('refuses an inbound id containing %s', async (_case, forged) => {
    requestArrives(forged);

    const id = await currentCorrelationId();
    expect(id).not.toBe(forged);
    // Refused, not rejected: a bad inbound id costs the caller their trace, not
    // their request.
    expect(id).toMatch(/^[A-Za-z0-9-]{36}$/);
  });

  it('is absent rather than invented when there is no request', async () => {
    // What `headers()` really does outside a request scope, verbatim. Minting
    // one here would put an id in a log that correlates a single call with
    // nothing, which is worse than no id at all.
    store.absent = true;

    expect(await currentCorrelationId()).toBeNull();
    expect(await correlationHeaders()).toEqual({});
  });
});

/**
 * Every client in `lib/` that talks to the API, called once each.
 *
 * The fetch double records the headers and answers with something each client
 * will reject — the outcome is irrelevant, and making every one of them answer
 * with a valid body would be a page of fixtures testing nothing. What is
 * asserted is that the request went out carrying the trace.
 */
describe('every API client forwards the correlation id', () => {
  function recording(): {
    seen: () => Record<string, string> | undefined;
    fetchImpl: (
      url: string,
      init?: { headers?: Record<string, string> },
    ) => Promise<{ status: number; text: () => Promise<string> }>;
  } {
    let headers: Record<string, string> | undefined;
    return {
      seen: () => headers,
      fetchImpl: (_url, init) => {
        headers = init?.headers;
        return Promise.resolve({ status: 200, text: () => Promise.resolve('{}') });
      },
    };
  }

  const calls: readonly (readonly [
    string,
    (fetchImpl: ReturnType<typeof recording>['fetchImpl']) => Promise<unknown>,
  ])[] = [
    ['account', (f) => fetchAccount(API, TOKEN, f)],
    ['activity', (f) => fetchActivity(API, TOKEN, f)],
    ['admin-activity', (f) => fetchAdminActivity(API, TOKEN, 'a-user', 'a reason', f)],
    ['admin-approvals', (f) => fetchPendingApprovals(API, TOKEN, f)],
    ['admin-categories', (f) => fetchCategories(API, TOKEN, f)],
    ['admin-feature-flags', (f) => fetchFeatureFlags(API, TOKEN, f)],
    [
      'admin-listings',
      (f) => moderateListing(API, TOKEN, 'a-listing', 'UNDER_REVIEW', 'a reason', f),
    ],
    ['admin-user', (f) => fetchAdminUser(API, TOKEN, 'a-user', 'a reason', f)],
    ['data-export', (f) => fetchDataExport(API, TOKEN, f)],
    ['deletion', (f) => requestDeletion(API, TOKEN, f)],
    ['listings (owner)', (f) => fetchOwnedListings(API, TOKEN, f)],
    ['listings (public)', (f) => fetchPublicListing(API, 'a-listing', f)],
    ['profile (read)', (f) => fetchMyProfile(API, TOKEN, f)],
    ['profile (public)', (f) => fetchPublicProfile(API, 'a-user', f)],
    ['readiness', (f) => fetchReadiness(API, f)],
    ['sign-ins', (f) => fetchSignIns(API, TOKEN, f)],
  ];

  it.each(calls)('%s', async (_name, call) => {
    requestArrives('edge-abc123');
    const { seen, fetchImpl } = recording();

    await call(fetchImpl);

    expect(seen()?.[CORRELATION_HEADER]).toBe('edge-abc123');
  });

  it('profile (save)', async () => {
    requestArrives('edge-abc123');
    const { seen, fetchImpl } = recording();

    await saveMyProfile(
      API,
      TOKEN,
      {
        displayName: 'Sarah M.',
        phone: '+447700900123',
        address: null,
        ownerStatus: 'private_owner',
      },
      fetchImpl,
    );

    expect(seen()?.[CORRELATION_HEADER]).toBe('edge-abc123');
  });

  it('clerk-webhook, which is the one trace that starts at a provider', async () => {
    requestArrives('edge-abc123');
    const { seen, fetchImpl } = recording();

    await forwardIdentityEvent(
      API,
      { deliveryId: 'msg_1', type: 'user.created', data: {} },
      fetchImpl,
    );

    expect(seen()?.[CORRELATION_HEADER]).toBe('edge-abc123');
  });
});
