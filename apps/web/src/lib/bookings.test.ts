import { describe, expect, it } from 'vitest';
import {
  fetchBooking,
  fetchBookingsOnMyListings,
  fetchMyBookings,
  payForBooking,
  requestBooking,
} from './bookings';
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

/**
 * Reading one booking, and paying for it (slice 5.2d).
 *
 * **`fetchBooking` is the first caller `GET /bookings/:bookingId` has ever had**,
 * which is why the route survived the deletion deadline its docblock carried.
 */
const A_DETAIL = { ...A_BOOKING, state: 'ACCEPTED', payability: { payable: true } };

describe('fetchBooking', () => {
  it('addresses the one booking, and parses the detail projection', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(A_DETAIL));

    const outcome = await fetchBooking(API, TOKEN, A_BOOKING.id, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/bookings/${A_BOOKING.id}`);
    expect(outcome).toEqual({ kind: 'loaded', value: A_DETAIL });
  });

  /**
   * **The field this slice added, and the reason the detail projection exists.**
   * A payload without it is the collection projection arriving on this route, and
   * a page that fell back to "no button" on it would silently stop anybody paying.
   */
  it('refuses a booking with no payability on it', async () => {
    const outcome = await fetchBooking(
      API,
      TOKEN,
      A_BOOKING.id,
      responds(200, JSON.stringify(A_BOOKING)),
    );

    expect(outcome.kind).toBe('malformed');
  });

  /**
   * **`payable: false` must carry a reason**, which the discriminated union makes
   * unrepresentable rather than merely discouraged — an unavailable control with
   * no explanation beside it is the exact defect this slice removes.
   */
  it('refuses an unavailable payment with no reason given', async () => {
    const outcome = await fetchBooking(
      API,
      TOKEN,
      A_BOOKING.id,
      responds(200, JSON.stringify({ ...A_BOOKING, payability: { payable: false } })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports "not yours or no such booking" as one answer', async () => {
    // The API refuses to tell them apart; nothing here may undo that.
    expect((await fetchBooking(API, TOKEN, A_BOOKING.id, responds(404))).kind).toBe(
      'not-found',
    );
  });
});

describe('payForBooking', () => {
  const PAID = {
    booking: { ...A_BOOKING, state: 'RESERVED' },
    payment: { status: 'succeeded' },
  };

  it('posts to the booking with no body at all', async () => {
    /*
     * **§8.7 calculates charges server-side only.** What is owed was fixed when
     * the booking was made and is on its row; a client that could send an amount
     * could send the wrong one. The assertion is what would fail if somebody
     * later "helpfully" started sending the total.
     */
    const { calls, fetchImpl } = capturing(200, JSON.stringify(PAID));

    const outcome = await payForBooking(API, TOKEN, A_BOOKING.id, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/bookings/${A_BOOKING.id}/pay`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(outcome).toEqual({ kind: 'loaded', value: PAID });
  });

  /**
   * **No idempotency key crosses this wire.** Payments derives its own from the
   * booking and the count of failed attempts (5.2c), so a double press charges
   * once without a browser having to be trusted with it.
   */
  it('sends nothing that could be mistaken for an idempotency key', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(PAID));

    await payForBooking(API, TOKEN, A_BOOKING.id, fetchImpl);

    expect(JSON.stringify(calls[0])).not.toMatch(/idempotenc|attemptKey/i);
  });

  it('carries a refusal through verbatim', async () => {
    // 5.2c writes these for the renter reading them, and every one says whether
    // anything was charged.
    const refusal = 'That booking is already paid for. Nothing has been charged again.';

    expect(
      await payForBooking(
        API,
        TOKEN,
        A_BOOKING.id,
        responds(422, JSON.stringify({ message: refusal })),
      ),
    ).toEqual({ kind: 'refused', reason: refusal });
  });

  it('reports a signed-out caller rather than attempting a payment', async () => {
    expect((await payForBooking(API, null, A_BOOKING.id)).kind).toBe('signed-out');
  });
});
