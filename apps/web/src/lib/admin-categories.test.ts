import { describe, expect, it } from 'vitest';
import {
  createCategory,
  fetchCategories,
  reconfigureCategory,
} from './admin-categories';
import type { FetchLike } from './admin-categories';

/** A priced category (BRD §8.2, §3.4, slice 2.7a). */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';
const REASON = 'opening the launch category for the pilot';

const CATEGORY = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  riskLevel: 'low',
  // The flag is part of what a category *is*, so it comes back on the read.
  // The acknowledgement is not, and its absence here is asserted by the parse:
  // it is an assertion about a request, and a response carrying it would be
  // claiming to have evidence of something it never held.
  reportableActivity: 'none',
  attributes: [],
  feePolicy: FEE_POLICY,
  transportOptions: [],
  versionNumber: 1,
  versionCreatedAt: '2026-08-03T09:00:00.000Z',
  createdAt: '2026-08-03T09:00:00.000Z',
};

const DRAFT = {
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  riskLevel: 'low',
  reportableActivity: 'none',
  reportingDutiesAcknowledged: false,
  attributes: [],
  feePolicy: FEE_POLICY,
  transportOptions: [],
} as const;

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

describe('fetchCategories', () => {
  it('returns the list', async () => {
    const outcome = await fetchCategories(
      API,
      TOKEN,
      responds(200, JSON.stringify({ categories: [CATEGORY] })),
    );

    expect(outcome).toEqual({ kind: 'loaded', value: [CATEGORY] });
  });

  it('is signed out without a token, without calling the API', async () => {
    let called = false;
    const outcome = await fetchCategories(API, null, () => {
      called = true;
      return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reports a mis-shaped list as malformed rather than rendering it', async () => {
    // Zod strips unknown keys, so a missing *required* field is what proves the
    // parse runs at all — asserting on a parsed object would hide a leak or a
    // gap rather than catch it.
    const outcome = await fetchCategories(
      API,
      TOKEN,
      responds(200, JSON.stringify({ categories: [{ slug: 'only-a-slug' }] })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports a stale second factor as forbidden, not signed out', async () => {
    // The distinction matters to the person reading the page: signing in again
    // fixes one of these and not the other.
    expect((await fetchCategories(API, TOKEN, responds(403))).kind).toBe('forbidden');
    expect((await fetchCategories(API, TOKEN, responds(401))).kind).toBe('signed-out');
  });

  it('never serves configuration from a cache', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify({ categories: [] }));
    await fetchCategories(API, TOKEN, fetchImpl);

    expect(calls[0]?.init?.cache).toBe('no-store');
  });
});

describe('createCategory', () => {
  it('sends the draft and the reason', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(CATEGORY));
    await createCategory(API, TOKEN, DRAFT, REASON, fetchImpl);

    const sent = calls[0];
    expect(sent?.init?.method).toBe('POST');
    expect(sent?.url).toContain('/admin/categories');
    expect(JSON.parse(sent?.init?.body ?? '{}')).toEqual(DRAFT);

    // §8.13 wants a reason on every admin action, and it travels in the query
    // rather than the body so the body stays exactly the contract's shape.
    //
    // Asserted by reading the parameter back rather than by matching the
    // encoded string. `URLSearchParams` writes a space as `+`, which is correct
    // for a query string and is *not* what `encodeURIComponent` produces — an
    // assertion against the literal encoding would pin the spelling rather than
    // the meaning, and would fail on a change that broke nothing.
    const reason = new URL(sent?.url ?? '').searchParams.get('reason');
    expect(reason).toBe(REASON);
  });

  it('reports a taken slug distinctly from a malformed one', async () => {
    const taken = await createCategory(
      API,
      TOKEN,
      DRAFT,
      REASON,
      responds(409, JSON.stringify({ message: 'A category with that slug exists' })),
    );
    expect(taken).toEqual({
      kind: 'taken',
      reason: 'A category with that slug exists',
    });

    const invalid = await createCategory(
      API,
      TOKEN,
      DRAFT,
      REASON,
      responds(400, JSON.stringify({ issues: ['slug: must be lowercase'] })),
    );
    expect(invalid).toEqual({ kind: 'invalid', issues: ['slug: must be lowercase'] });
  });

  it('falls back to a usable message when the error body says nothing', async () => {
    const outcome = await createCategory(
      API,
      TOKEN,
      DRAFT,
      REASON,
      responds(409, 'not json'),
    );
    expect(outcome).toEqual({ kind: 'taken', reason: 'That slug is already in use.' });
  });
});

describe('reconfigureCategory', () => {
  it('PUTs the configuration to the category', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(CATEGORY));
    await reconfigureCategory(
      API,
      TOKEN,
      'outdoor-gardening',
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      'renamed after the taxonomy review',
      fetchImpl,
    );

    const sent = calls[0];
    expect(sent?.init?.method).toBe('PUT');
    expect(sent?.url).toContain('/admin/categories/outdoor-gardening');
  });

  it('sends no slug in the body, because the route cannot change it', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(CATEGORY));
    await reconfigureCategory(
      API,
      TOKEN,
      'outdoor-gardening',
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      'renamed after the taxonomy review',
      fetchImpl,
    );

    // A slug that can move breaks every indexed URL pointing at the category.
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).not.toHaveProperty('slug');
  });

  it('reports a missing category as not-found', async () => {
    const outcome = await reconfigureCategory(
      API,
      TOKEN,
      'no-such-category',
      {
        name: 'Nothing',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      REASON,
      responds(404),
    );
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('escapes a slug rather than pasting it into the path', async () => {
    const { calls, fetchImpl } = capturing(404);
    await reconfigureCategory(
      API,
      TOKEN,
      'a/b',
      {
        name: 'Nothing',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      REASON,
      fetchImpl,
    );

    expect(calls[0]?.url).toContain('a%2Fb');
  });
});
