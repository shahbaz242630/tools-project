import { describe, expect, it } from 'vitest';
import { blockPeriod, fetchAvailability, unblockPeriod } from './availability';
import type { FetchLike } from './listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const LISTING = '11111111-1111-4111-8111-111111111111';
const BLOCK = '22222222-2222-4222-8222-222222222222';

const A_BLOCK = {
  id: BLOCK,
  startDate: '2026-08-20',
  endDate: '2026-08-22',
  reason: 'Away',
};

const A_MONTH = { month: '2026-08', blocks: [A_BLOCK] };

const A_PERIOD = { startDate: '2026-08-20', endDate: '2026-08-22', reason: 'Away' };

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

describe('fetchAvailability', () => {
  it('reads a month and parses it', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(A_MONTH));
    const outcome = await fetchAvailability(API, TOKEN, LISTING, '2026-08', fetchImpl);

    expect(calls[0]?.url).toContain(`/listings/${LISTING}/availability?month=2026-08`);
    expect(outcome).toEqual({ kind: 'loaded', value: A_MONTH });
  });

  it('sends no month parameter at all when none was chosen', async () => {
    /*
     * **Absent, not empty.** `?month=` would be a value the API has to decide the
     * meaning of, and the meaning it would have to choose is the one an absent
     * parameter already has — the same argument ADR 0046 makes about a filter
     * that contributes no SQL rather than an always-true clause.
     */
    const { calls, fetchImpl } = capturing(200, JSON.stringify(A_MONTH));
    await fetchAvailability(API, TOKEN, LISTING, null, fetchImpl);

    expect(calls[0]?.url).not.toContain('month');
  });

  it('reports somebody else’s listing as not-found', async () => {
    expect(await fetchAvailability(API, TOKEN, LISTING, null, responds(404))).toEqual({
      kind: 'not-found',
    });
  });

  it('does not call the API at all with no token', async () => {
    // The guard in `call`: a signed-out read is answered here rather than by a
    // round trip that would come back 401.
    const { calls, fetchImpl } = capturing(200, JSON.stringify(A_MONTH));
    const outcome = await fetchAvailability(API, null, LISTING, null, fetchImpl);

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(calls).toHaveLength(0);
  });

  it('reports a body that is not a calendar as malformed', async () => {
    // What the strict parse is for: an instant appearing in the projection is a
    // failure here rather than a date rendered in the browser's timezone.
    const outcome = await fetchAvailability(
      API,
      TOKEN,
      LISTING,
      null,
      responds(
        200,
        JSON.stringify({
          month: '2026-08',
          blocks: [{ ...A_BLOCK, startAt: '2026-08-19T23:00:00.000Z' }],
        }),
      ),
    );

    expect(outcome.kind).toBe('malformed');
  });
});

describe('blockPeriod', () => {
  it('POSTs the period', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_BLOCK));
    const outcome = await blockPeriod(API, TOKEN, LISTING, A_PERIOD, fetchImpl);

    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual(A_PERIOD);
    expect(outcome).toEqual({ kind: 'loaded', value: A_BLOCK });
  });

  it('reads a 422 as a refusal, carrying the API’s own sentence', async () => {
    /*
     * **Not `invalid`.** The two need opposite things from the person reading
     * them: `invalid` asks them to correct a field, and this says the period
     * itself is one we will not accept — there is no field to fix. Collapsing
     * them would put a sentence about the year under a date that is perfectly
     * well formed.
     */
    const outcome = await blockPeriod(
      API,
      TOKEN,
      LISTING,
      A_PERIOD,
      responds(422, JSON.stringify({ message: 'That period has already finished.' })),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'That period has already finished.',
    });
  });

  it('falls back to a usable sentence when the refusal body says nothing', async () => {
    const outcome = await blockPeriod(
      API,
      TOKEN,
      LISTING,
      A_PERIOD,
      responds(422, 'not json'),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'those dates were not accepted',
    });
  });

  it('surfaces field issues from a 400', async () => {
    const outcome = await blockPeriod(
      API,
      TOKEN,
      LISTING,
      A_PERIOD,
      responds(400, JSON.stringify({ issues: ['startDate: must be a date'] })),
    );

    expect(outcome).toEqual({ kind: 'invalid', issues: ['startDate: must be a date'] });
  });
});

describe('unblockPeriod', () => {
  it('DELETEs the period and reads a 204 as success', async () => {
    /*
     * **The whole reason `call` learned about 204.** An empty body reaching
     * `JSON.parse` throws, so before this the delete would have come back
     * `malformed` and the page would have reported a failure for something it
     * had just done.
     */
    const { calls, fetchImpl } = capturing(204);
    const outcome = await unblockPeriod(API, TOKEN, LISTING, BLOCK, fetchImpl);

    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain(`/listings/${LISTING}/availability/${BLOCK}`);
    expect(outcome).toEqual({ kind: 'loaded', value: null });
  });

  it('reports a period that is already gone as not-found', async () => {
    expect(await unblockPeriod(API, TOKEN, LISTING, BLOCK, responds(404))).toEqual({
      kind: 'not-found',
    });
  });

  it('reports a suspended account as forbidden', async () => {
    // Reachable, unlike on the block route: putting dates back on offer is a
    // write ADR 0024 suspends.
    expect(await unblockPeriod(API, TOKEN, LISTING, BLOCK, responds(403))).toEqual({
      kind: 'forbidden',
    });
  });
});
