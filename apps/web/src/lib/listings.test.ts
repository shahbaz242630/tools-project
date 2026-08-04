import { describe, expect, it } from 'vitest';
import { createListing, fetchCategoryOptions, fetchListing } from './listings';
import type { FetchLike } from './listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

const LISTING = {
  id: '11111111-1111-4111-8111-111111111111',
  categorySlug: 'outdoor-gardening',
  categoryName: 'Outdoor and gardening',
  categoryVersionNumber: 1,
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
  status: 'DRAFT',
  createdAt: '2026-08-04T09:00:00.000Z',
  updatedAt: '2026-08-04T09:00:00.000Z',
};

const DRAFT = {
  categorySlug: 'outdoor-gardening',
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
} as const;

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

describe('createListing', () => {
  it('POSTs the draft', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(LISTING));
    const outcome = await createListing(API, TOKEN, DRAFT, fetchImpl);

    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/listings');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual(DRAFT);
    expect(outcome.kind).toBe('loaded');
  });

  it('reports an unknown category as not-found, not as invalid', async () => {
    // Different fixes: one means choose again, the other means correct a field.
    const outcome = await createListing(API, TOKEN, DRAFT, responds(404));
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('surfaces the field-level issues on a rejection', async () => {
    const outcome = await createListing(
      API,
      TOKEN,
      DRAFT,
      responds(
        400,
        JSON.stringify({ issues: ['title: must be at least 3 characters'] }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'invalid',
      issues: ['title: must be at least 3 characters'],
    });
  });

  it('falls back to a usable message when the error body says nothing', async () => {
    const outcome = await createListing(API, TOKEN, DRAFT, responds(400, 'not json'));
    expect(outcome).toEqual({ kind: 'invalid', issues: ['The request was rejected'] });
  });

  it('reports a suspended account as forbidden, not signed out', async () => {
    expect((await createListing(API, TOKEN, DRAFT, responds(403))).kind).toBe(
      'forbidden',
    );
    expect((await createListing(API, TOKEN, DRAFT, responds(401))).kind).toBe(
      'signed-out',
    );
  });

  it('does not call the API without a token', async () => {
    let called = false;
    const outcome = await createListing(API, null, DRAFT, () => {
      called = true;
      return Promise.resolve({ status: 201, text: () => Promise.resolve('') });
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reports an unexpected status as unreachable rather than pretending', async () => {
    expect((await createListing(API, TOKEN, DRAFT, responds(500))).kind).toBe(
      'unreachable',
    );
  });

  it('reports a transport failure as unreachable', async () => {
    const outcome = await createListing(API, TOKEN, DRAFT, () =>
      Promise.reject(new Error('socket hang up')),
    );

    expect(outcome).toEqual({ kind: 'unreachable', reason: 'socket hang up' });
  });

  it('reports a mis-shaped success as malformed rather than rendering it', async () => {
    const outcome = await createListing(
      API,
      TOKEN,
      DRAFT,
      responds(201, JSON.stringify({ id: 'only-an-id' })),
    );

    expect(outcome.kind).toBe('malformed');
  });
});

describe('fetchListing', () => {
  it('reads one by id and never from a cache', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(LISTING));
    await fetchListing(API, TOKEN, LISTING.id, fetchImpl);

    expect(calls[0]?.url).toContain(`/listings/${LISTING.id}`);
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('escapes an id rather than pasting it into the path', async () => {
    const { calls, fetchImpl } = capturing(404);
    await fetchListing(API, TOKEN, '../admin/categories', fetchImpl);

    expect(calls[0]?.url).not.toContain('/admin/categories');
  });

  it('reports somebody else’s listing as not-found', async () => {
    expect((await fetchListing(API, TOKEN, LISTING.id, responds(404))).kind).toBe(
      'not-found',
    );
  });
});

describe('fetchCategoryOptions', () => {
  it('returns the options', async () => {
    const outcome = await fetchCategoryOptions(
      API,
      TOKEN,
      responds(
        200,
        JSON.stringify({
          categories: [{ slug: 'outdoor-gardening', name: 'Outdoor and gardening' }],
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      value: [{ slug: 'outdoor-gardening', name: 'Outdoor and gardening' }],
    });
  });

  it('treats an empty list as a successful read', async () => {
    // Not an error: no category existing yet is a state of the platform, and
    // the page has a sentence for it.
    const outcome = await fetchCategoryOptions(
      API,
      TOKEN,
      responds(200, JSON.stringify({ categories: [] })),
    );

    expect(outcome).toEqual({ kind: 'loaded', value: [] });
  });

  it('reports a mis-shaped list as malformed', async () => {
    const outcome = await fetchCategoryOptions(
      API,
      TOKEN,
      responds(200, JSON.stringify({ categories: [{ slug: 'only-a-slug' }] })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('forwards the client IP when it has one', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify({ categories: [] }));
    await fetchCategoryOptions(API, TOKEN, fetchImpl, '203.0.113.7');

    expect(calls[0]?.init?.headers?.['x-client-ip']).toBe('203.0.113.7');
  });
});
