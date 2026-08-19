import { describe, expect, it } from 'vitest';
import { fetchBookingsOnMyListings, fetchMyBookings, requestBooking } from './bookings';
import type { FetchLike } from './listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const QUOTE = '33333333-3333-4333-8333-333333333333';

const A_BOOKING = {
  id: '44444444-4444-4444-8444-444444444444',
  listingId: '11111111-1111-4111-8111-111111111111',
  state: 'REQUESTED',
  startDate: '2026-08-20',
  endDate: '2026-08-22',
  days: 3,
  itemTitle: 'Petrol hedge trimmer, 60cm blade',
  categoryName: 'Outdoor & gardening',
  itemCharge: { amount: 5400, currency: 'GBP' },
  renterFee: { amount: 432, currency: 'GBP' },
  total: { amount: 5832, currency: 'GBP' },
  lineItems: [
    {
      unit: 'day',
      count: 3,
      unitPrice: { amount: 1800, currency: 'GBP' },
      subtotal: { amount: 5400, currency: 'GBP' },
    },
  ],
  requestExpiresAt: '2026-08-20T10:00:00.000Z',
  events: [
    {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      at: '2026-08-18T10:00:00.000Z',
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

describe('requestBooking', () => {
  it('posts the quote id and nothing else', async () => {
    /*
     * **The contract's decision, asserted where it is actually sent.** Every
     * other term is on the quote; restating the dates or the price here would
     * create a second version of them that somebody would then have to choose
     * between. The exact-equality assertion is what would fail if a later change
     * started "helpfully" including them.
     */
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_BOOKING));
    const outcome = await requestBooking(API, TOKEN, QUOTE, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/bookings`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ quoteId: QUOTE }));
    expect(outcome).toEqual({ kind: 'loaded', value: A_BOOKING });
  });

  it('carries an expired price through as a refusal, verbatim', async () => {
    // 4.5a's sentence tells the renter what to do next. This layer repeats it
    // rather than summarising it.
    const expired =
      'That price has expired. Ask for the dates again and you will get a fresh ' +
      'quote — the price may have changed.';

    expect(
      await requestBooking(
        API,
        TOKEN,
        QUOTE,
        responds(422, JSON.stringify({ message: expired })),
      ),
    ).toEqual({ kind: 'refused', reason: expired });
  });

  it('carries a withdrawn listing through as a refusal', async () => {
    // A quote outlives the facts it was built on: thirty minutes is long enough
    // for an owner to pause the listing, and 4.5a re-checks rather than trusting
    // the quote it is handed.
    const withdrawn =
      'This item is no longer available to book. It may have been withdrawn since ' +
      'you asked for a price.';

    expect(
      await requestBooking(
        API,
        TOKEN,
        QUOTE,
        responds(422, JSON.stringify({ message: withdrawn })),
      ),
    ).toEqual({ kind: 'refused', reason: withdrawn });
  });

  it('still refuses when a 422 arrives with no sentence in it', async () => {
    expect(await requestBooking(API, TOKEN, QUOTE, responds(422, ''))).toEqual({
      kind: 'refused',
      reason: 'that request was not accepted',
    });
  });

  it('reports somebody else’s quote as not-found', async () => {
    // "Not yours" and "no such quote" arrive as the same 404 on purpose —
    // telling them apart would confirm a quote id to somebody guessing them.
    expect(await requestBooking(API, TOKEN, QUOTE, responds(404))).toEqual({
      kind: 'not-found',
    });
  });

  it('does not call the API at all with no token', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_BOOKING));
    const outcome = await requestBooking(API, null, QUOTE, fetchImpl);

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(calls).toHaveLength(0);
  });

  it('reports a body that is not a booking as malformed', async () => {
    const outcome = await requestBooking(
      API,
      TOKEN,
      QUOTE,
      responds(201, JSON.stringify({ ...A_BOOKING, startAt: '2026-08-20T00:00:00Z' })),
    );

    expect(outcome.kind).toBe('malformed');
  });
});

const A_SUMMARY = {
  id: '44444444-4444-4444-8444-444444444444',
  listingId: '11111111-1111-4111-8111-111111111111',
  state: 'ACCEPTED',
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  days: 3,
  itemTitle: 'Petrol hedge trimmer, 60cm blade',
  categoryName: 'Outdoor & gardening',
  total: { amount: 5832, currency: 'GBP' },
  requestExpiresAt: '2026-09-01T09:00:00.000Z',
};

const AN_OWNER_SUMMARY = {
  id: '55555555-5555-4555-8555-555555555555',
  listingId: '22222222-2222-4222-8222-222222222222',
  state: 'ACCEPTED',
  startDate: '2026-09-14',
  endDate: '2026-09-16',
  days: 3,
  itemTitle: 'SDS+ rotary hammer drill',
  itemCharge: { amount: 5400, currency: 'GBP' },
  requestExpiresAt: '2026-09-01T09:00:00.000Z',
};

describe('the two dashboard reads (slice 4.8b)', () => {
  it('asks the renter route for what this person requested', async () => {
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ bookings: [A_SUMMARY], truncated: false }),
    );

    const outcome = await fetchMyBookings(API, TOKEN, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/bookings`);
    expect(outcome).toEqual({
      kind: 'loaded',
      value: { bookings: [A_SUMMARY], truncated: false },
    });
  });

  it('asks the owner route for what is booked on their listings', async () => {
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ bookings: [AN_OWNER_SUMMARY], truncated: false }),
    );

    const outcome = await fetchBookingsOnMyListings(API, TOKEN, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/owner/bookings`);
    expect(outcome).toEqual({
      kind: 'loaded',
      value: { bookings: [AN_OWNER_SUMMARY], truncated: false },
    });
  });

  it('sends no role parameter on either, because neither route takes one', async () => {
    /*
     * **The security decision, asserted where it could be undone.** A role a
     * caller names is a scope a caller chooses; both routes take theirs from the
     * session. Nothing in this file passes a role, so nothing in this file can
     * pass the wrong one — and this is what would fail if somebody "simplified"
     * the two calls into one parameterised helper.
     */
    const mine = capturing(200, JSON.stringify({ bookings: [], truncated: false }));
    const owned = capturing(200, JSON.stringify({ bookings: [], truncated: false }));

    await fetchMyBookings(API, TOKEN, mine.fetchImpl);
    await fetchBookingsOnMyListings(API, TOKEN, owned.fetchImpl);

    for (const { url } of [...mine.calls, ...owned.calls]) {
      expect(url).not.toMatch(/[?&]role=/);
      expect(url).not.toMatch(/[?&]party=/);
    }
  });

  it('carries the truncation flag rather than dropping it', async () => {
    // H2's rule: the array alone loses the one fact the reader has to be told,
    // at the one boundary where the loss is invisible.
    const outcome = await fetchMyBookings(
      API,
      TOKEN,
      responds(200, JSON.stringify({ bookings: [A_SUMMARY], truncated: true })),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      value: { bookings: [A_SUMMARY], truncated: true },
    });
  });

  it('refuses a payload that is not the projection', async () => {
    // `strictObject` on the contract. A field added on the server and forgotten
    // here fails loudly rather than being dropped in transit.
    const outcome = await fetchMyBookings(
      API,
      TOKEN,
      responds(200, JSON.stringify({ bookings: [{ ...A_SUMMARY, renterId: 'u-1' }] })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports a signed-out caller rather than an empty list', async () => {
    // The distinction the pages are built around: "you have none" and "we could
    // not ask" must never look the same.
    expect((await fetchMyBookings(API, null)).kind).toBe('signed-out');
    expect((await fetchBookingsOnMyListings(API, null)).kind).toBe('signed-out');
  });
});
