import { describe, expect, it } from 'vitest';
import { requestQuote } from './quotes';
import type { FetchLike } from './listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const LISTING = '11111111-1111-4111-8111-111111111111';

const A_PERIOD = {
  startDate: '2026-08-20',
  endDate: '2026-08-22',
  postcode: 'BS7 8AA',
};

const A_QUOTE = {
  id: '33333333-3333-4333-8333-333333333333',
  listingId: LISTING,
  startDate: '2026-08-20',
  endDate: '2026-08-22',
  days: 3,
  postcode: 'BS7 8AA',
  lineItems: [
    {
      unit: 'day',
      count: 3,
      unitPrice: { amount: 1800, currency: 'GBP' },
      subtotal: { amount: 5400, currency: 'GBP' },
    },
  ],
  itemCharge: { amount: 5400, currency: 'GBP' },
  renterFee: { amount: 432, currency: 'GBP' },
  minimumFeeApplied: false,
  total: { amount: 5832, currency: 'GBP' },
  appliedExcess: { amount: { amount: 7500, currency: 'GBP' }, boundBy: 'floor' },
  expiresAt: '2026-08-18T10:30:00.000Z',
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

describe('requestQuote', () => {
  it('posts the period to the listing and parses the quote back', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_QUOTE));
    const outcome = await requestQuote(API, TOKEN, LISTING, A_PERIOD, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/listings/${LISTING}/quotes`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(outcome).toEqual({ kind: 'loaded', value: A_QUOTE });
  });

  it('sends the dates as the strings they arrived as', async () => {
    /*
     * **The rule this file exists to keep.** A `Date` anywhere on this path is a
     * conversion in the renderer's timezone, which is wrong for seven months a
     * year in a way no reviewer sees. The assertion is on the body bytes rather
     * than on a parsed object, because a `Date` that survived to here would be
     * serialised into an instant and this is where that shows.
     */
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_QUOTE));
    await requestQuote(API, TOKEN, LISTING, A_PERIOD, fetchImpl);

    expect(calls[0]?.init?.body).toBe(JSON.stringify(A_PERIOD));
    expect(calls[0]?.init?.body).not.toContain('T00:00');
  });

  it('carries a 422 through as a refusal, in the API’s own words', async () => {
    // The sentence is written for the person who chose the dates. Anything this
    // layer added would be talking over it.
    const outcome = await requestQuote(
      API,
      TOKEN,
      LISTING,
      A_PERIOD,
      responds(
        422,
        JSON.stringify({ message: 'This hire is longer than this category allows.' }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'This hire is longer than this category allows.',
    });
  });

  it('still refuses when a 422 arrives with no sentence in it', async () => {
    // A refusal without words is still a refusal, and must not fall through to
    // `unreachable` and print a status code at somebody.
    expect(
      await requestQuote(API, TOKEN, LISTING, A_PERIOD, responds(422, 'nonsense')),
    ).toEqual({ kind: 'refused', reason: 'that period could not be priced' });
  });

  it('reports an unbookable listing as not-found without unpicking why', async () => {
    // Four facts arrive as one 404 — no such listing, not published, hidden by
    // the platform, or a business owner. The API refuses to distinguish them and
    // this client must not invent a distinction it was denied.
    expect(await requestQuote(API, TOKEN, LISTING, A_PERIOD, responds(404))).toEqual({
      kind: 'not-found',
    });
  });

  it('does not call the API at all with no token', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_QUOTE));
    const outcome = await requestQuote(API, null, LISTING, A_PERIOD, fetchImpl);

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(calls).toHaveLength(0);
  });

  it('reports a body that is not a quote as malformed', async () => {
    /*
     * What `rentalQuoteSchema`'s `strictObject` is for. The day something adds
     * `startAt` to that projection this fails, rather than an instant reaching a
     * page that would render it in the browser's timezone.
     */
    const outcome = await requestQuote(
      API,
      TOKEN,
      LISTING,
      A_PERIOD,
      responds(
        201,
        JSON.stringify({ ...A_QUOTE, startAt: '2026-08-20T00:00:00.000Z' }),
      ),
    );

    expect(outcome.kind).toBe('malformed');
  });
});
