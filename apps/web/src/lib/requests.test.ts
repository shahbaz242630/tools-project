import { describe, expect, it } from 'vitest';
import { acceptRequest, declineRequest, fetchRequests } from './requests';
import type { FetchLike } from './listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const LISTING = '11111111-1111-4111-8111-111111111111';
const BOOKING = '44444444-4444-4444-8444-444444444444';

const A_REQUEST = {
  id: BOOKING,
  startDate: '2026-09-15',
  endDate: '2026-09-17',
  days: 3,
  itemCharge: { amount: 5_400, currency: 'GBP' },
  appliedExcess: { amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' },
  requestExpiresAt: '2026-09-13T09:00:00.000Z',
  conflictCount: 1,
};

const A_BOOKING = {
  id: BOOKING,
  listingId: LISTING,
  state: 'ACCEPTED',
  startDate: '2026-09-15',
  endDate: '2026-09-17',
  days: 3,
  itemTitle: 'Petrol hedge trimmer, 60cm blade',
  categoryName: 'Outdoor and gardening',
  itemCharge: { amount: 5_400, currency: 'GBP' },
  renterFee: { amount: 432, currency: 'GBP' },
  total: { amount: 5_832, currency: 'GBP' },
  appliedExcess: { amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' },
  lineItems: [
    {
      unit: 'day',
      count: 3,
      unitPrice: { amount: 1_800, currency: 'GBP' },
      subtotal: { amount: 5_400, currency: 'GBP' },
    },
  ],
  requestExpiresAt: '2026-09-13T09:00:00.000Z',
  events: [
    {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      at: '2026-09-11T09:00:00.000Z',
    },
    {
      type: 'state-changed',
      fromState: 'REQUESTED',
      toState: 'ACCEPTED',
      at: '2026-09-11T10:00:00.000Z',
    },
  ],
};

function responds(status: number, body = ''): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

function capturing(status: number, body = '') {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return Promise.resolve({ status, text: () => Promise.resolve(body) });
  };
  return { calls, fetchImpl };
}

describe('fetchRequests', () => {
  it('reads what is waiting on this listing', async () => {
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ requests: [A_REQUEST] }),
    );
    const outcome = await fetchRequests(API, TOKEN, LISTING, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/listings/${LISTING}/requests`);
    expect(outcome).toEqual({ kind: 'loaded', value: { requests: [A_REQUEST] } });
  });

  it('reports a body that is not a request list as malformed', async () => {
    /*
     * What `listingRequestSchema`'s `strictObject` is for. The day somebody adds
     * the renter's name to that projection this fails, rather than a stranger's
     * identity reaching a page that would happily render it.
     */
    const outcome = await fetchRequests(
      API,
      TOKEN,
      LISTING,
      responds(
        200,
        JSON.stringify({ requests: [{ ...A_REQUEST, renterName: 'Priya K.' }] }),
      ),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('does not call the API at all with no token', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify({ requests: [] }));

    expect(await fetchRequests(API, null, LISTING, fetchImpl)).toEqual({
      kind: 'signed-out',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('answering a request', () => {
  it('posts to the accept route with no body', async () => {
    // Nothing to send: the decision *is* the route. A body here would be a
    // second place for the decision to live and a second thing to get wrong.
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_BOOKING));
    const outcome = await acceptRequest(API, TOKEN, BOOKING, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/bookings/${BOOKING}/accept`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(outcome).toEqual({ kind: 'loaded', value: A_BOOKING });
  });

  it('posts to the decline route', async () => {
    const { calls, fetchImpl } = capturing(
      201,
      JSON.stringify({ ...A_BOOKING, state: 'DECLINED' }),
    );
    await declineRequest(API, TOKEN, BOOKING, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/bookings/${BOOKING}/decline`);
  });

  it('carries a 422 through as a refusal, in the API’s own words', async () => {
    const expired =
      'That request has expired, so it can no longer be accepted. The renter can ' +
      'ask again.';

    expect(
      await acceptRequest(
        API,
        TOKEN,
        BOOKING,
        responds(422, JSON.stringify({ message: expired })),
      ),
    ).toEqual({ kind: 'refused', reason: expired });
  });

  it('keeps a 409 distinct from a 422, because they need opposite advice', async () => {
    /*
     * **The H3a lesson, one status along.** A 422 is something the owner can act
     * on — the request expired, or their own calendar blocks it. A 409 is
     * somebody else's acceptance holding the period: nothing they change fixes
     * it, and it is not their mistake. Collapsing the two would point them at the
     * one thing that cannot work.
     */
    const outcome = await acceptRequest(
      API,
      TOKEN,
      BOOKING,
      responds(409, JSON.stringify({ message: 'Those dates have just been taken.' })),
    );

    expect(outcome).toEqual({
      kind: 'taken',
      reason: 'Those dates have just been taken.',
    });
  });

  it('still says something useful when a status arrives with no sentence', async () => {
    expect(await acceptRequest(API, TOKEN, BOOKING, responds(422, ''))).toEqual({
      kind: 'refused',
      reason: 'that request could not be answered',
    });
    expect((await acceptRequest(API, TOKEN, BOOKING, responds(409, ''))).kind).toBe(
      'taken',
    );
  });

  it('reports somebody else’s request as not-found', async () => {
    // "Not yours" and "no such request" arrive as one 404 on purpose.
    expect(await acceptRequest(API, TOKEN, BOOKING, responds(404))).toEqual({
      kind: 'not-found',
    });
  });

  it('reports a suspended account as forbidden', async () => {
    // ADR 0024: reading what is waiting survives suspension, answering it does
    // not. The two halves are asserted in the API's integration tests; this is
    // the client not losing the distinction on the way back.
    expect(await acceptRequest(API, TOKEN, BOOKING, responds(403))).toEqual({
      kind: 'forbidden',
    });
  });
});
