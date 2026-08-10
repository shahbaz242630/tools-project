import { describe, expect, it } from 'vitest';
import {
  createListing,
  fetchCategoryOptions,
  fetchListing,
  pauseListing,
  publishListing,
} from './listings';
import type { FetchLike } from './listings';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

const SCHEMA = [
  {
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
  },
] as const;

const LISTING = {
  id: '11111111-1111-4111-8111-111111111111',
  categorySlug: 'outdoor-gardening',
  categoryName: 'Outdoor and gardening',
  categoryVersionNumber: 1,
  categoryAttributes: SCHEMA,
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
  attributes: { weight_kg: 52 },
  transportRequirement: 'car_boot',
  requiresTwoPersonLift: false,
  collectionLocation: null,
  isLocated: false,
  rates: { daily: null, weekend: null, weekly: null },
  inclusiveDailyPrice: null,
  status: 'DRAFT',
  publicationAvailable: true,
  createdAt: '2026-08-04T09:00:00.000Z',
  updatedAt: '2026-08-04T09:00:00.000Z',
};

const DRAFT = {
  categorySlug: 'outdoor-gardening',
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
  categoryVersionNumber: 1,
  attributes: { weight_kg: '5.2' },
  // Null and false: a draft that has not said how it is collected, which §8.3
  // allows and 2.4c-ii made explicit rather than assumed.
  transportRequirement: null,
  requiresTwoPersonLift: false,
  // Null for the same reason: a draft need not say where the item is either
  // (§8.3, slice 2.5a). The field is required to be *present*, so omitting it
  // here would be the compile error that made every caller of this fixture
  // findable in the first place.
  collectionLocation: null,
  // Unpriced, which is what a draft nobody has priced looks like (§8.3). The
  // field is required to be *present* for the reason `collectionLocation` is.
  rates: { daily: null, weekend: null, weekly: null },
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

  it('reports a reconfigured category as its own outcome, not as invalid', async () => {
    // The two need opposite things from the person reading them: `invalid` asks
    // them to correct a field, this asks them to look again at fields that may
    // have changed shape underneath them.
    const outcome = await createListing(
      API,
      TOKEN,
      DRAFT,
      responds(
        409,
        JSON.stringify({ message: 'Category "x" was version 1 and is now 2' }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'stale-category',
      reason: 'Category "x" was version 1 and is now 2',
    });
  });

  it('still explains a conflict whose body says nothing', async () => {
    const outcome = await createListing(API, TOKEN, DRAFT, responds(409, 'not json'));
    expect(outcome).toEqual({
      kind: 'stale-category',
      reason: 'the category was changed while this page was open',
    });
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
          categories: [
            {
              slug: 'outdoor-gardening',
              name: 'Outdoor and gardening',
              attributes: SCHEMA,
              transportOptions: [],
              versionNumber: 1,
            },
          ],
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      value: [
        {
          slug: 'outdoor-gardening',
          name: 'Outdoor and gardening',
          attributes: SCHEMA,
          transportOptions: [],
          versionNumber: 1,
        },
      ],
    });
  });

  it('refuses a category whose schema this build could not render', async () => {
    // A configured type this version does not know means a form that would
    // silently omit a field an administrator set up. Failing loudly is the
    // better of the two outcomes — the same argument the API store makes.
    const outcome = await fetchCategoryOptions(
      API,
      TOKEN,
      responds(
        200,
        JSON.stringify({
          categories: [
            {
              slug: 'outdoor-gardening',
              name: 'Outdoor and gardening',
              attributes: [
                { key: 'when', label: 'When', required: false, type: 'date' },
              ],
              transportOptions: [],
              versionNumber: 1,
            },
          ],
        }),
      ),
    );

    expect(outcome.kind).toBe('malformed');
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

/**
 * Publishing, and the two refusals that are not about the request.
 *
 * These had no coverage at this layer before slice H3a — the 422 was proven in
 * the API's integration test and in the form component, and nothing asserted
 * that this module *translated* either one. That gap is exactly what let a 503
 * fall through to the generic branch.
 */
describe('publishListing', () => {
  it('returns the published listing', async () => {
    const outcome = await publishListing(
      API,
      TOKEN,
      LISTING.id,
      responds(201, JSON.stringify(LISTING)),
    );

    expect(outcome.kind).toBe('loaded');
  });

  it('reads a 422 as the listing not being ready, with its blockers', async () => {
    const outcome = await publishListing(
      API,
      TOKEN,
      LISTING.id,
      responds(
        422,
        JSON.stringify({
          message: 'This listing is not ready to be published yet.',
          blockers: [{ field: 'description', message: 'It has to say something.' }],
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'not-ready',
      blockers: [{ field: 'description', message: 'It has to say something.' }],
    });
  });

  it('reads a 503 as the platform switch being off, keeping the API’s message', () => {
    // Slice H3a, and it was found by pressing the button rather than by a test.
    // The API writes a careful sentence — "Publishing is temporarily switched
    // off across the platform. Your listing is saved and unchanged" — and
    // before this the owner saw "That did not complete — API answered 503",
    // because 503 fell through to the generic unknown-status branch.
    //
    // **The bug was not in the new code.** The kill switch worked perfectly; what
    // it made untrue was this module's assumption about which statuses publish
    // can answer with.
    const message =
      'Publishing is temporarily switched off across the platform. ' +
      'Your listing is saved and unchanged — try again shortly.';

    return expect(
      publishListing(
        API,
        TOKEN,
        LISTING.id,
        responds(503, JSON.stringify({ message })),
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: message });
  });

  it('falls back to a usable sentence when a 503 carries no message', async () => {
    const outcome = await publishListing(API, TOKEN, LISTING.id, responds(503));

    expect(outcome).toMatchObject({ kind: 'unavailable' });
    // Never the bare status code. Somebody who has just tried to publish needs
    // to know the platform refused rather than that their listing is wrong.
    expect('reason' in outcome ? outcome.reason : '').toContain('switched off');
  });
});

/**
 * Pausing, and the status code that already meant something else.
 *
 * The test worth having here is the 409 one. `call` maps every 409 to
 * `stale-category` — correct for `createListing`, where a conflict really does
 * mean the category moved underneath the form — so without a hook of its own, a
 * pause refused for being a draft would have reported *"the category was changed
 * while this page was open"*. That is H3a's defect one status along: **a status
 * reused on the server is not handled until the client says which meaning it
 * has.**
 */
describe('pauseListing', () => {
  it('returns the paused listing', async () => {
    const outcome = await pauseListing(
      API,
      TOKEN,
      LISTING.id,
      responds(200, JSON.stringify({ ...LISTING, status: 'PAUSED' })),
    );

    expect(outcome.kind).toBe('loaded');
  });

  it('sends DELETE, because pausing removes the publication', async () => {
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ ...LISTING, status: 'PAUSED' }),
    );
    await pauseListing(API, TOKEN, LISTING.id, fetchImpl);

    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/publication');
  });

  it('reads a 409 as a refusal, keeping the API’s sentence', async () => {
    const message = 'This listing is not published, so there is nothing to pause.';

    const outcome = await pauseListing(
      API,
      TOKEN,
      LISTING.id,
      responds(409, JSON.stringify({ message })),
    );

    expect(outcome).toEqual({ kind: 'refused', reason: message });
  });

  it('does not report a refused pause as a changed category', async () => {
    const outcome = await pauseListing(
      API,
      TOKEN,
      LISTING.id,
      responds(
        409,
        JSON.stringify({
          message: 'This listing is not published, so there is nothing to pause.',
        }),
      ),
    );

    // The assertion this whole hook exists for. Without it the owner is told
    // something plausible, specific and untrue about their category.
    expect(outcome.kind).not.toBe('stale-category');
  });

  it('falls back to a usable sentence when a 409 carries no message', async () => {
    const outcome = await pauseListing(API, TOKEN, LISTING.id, responds(409));

    expect(outcome).toMatchObject({ kind: 'refused' });
    expect('reason' in outcome ? outcome.reason : '').toContain('cannot be paused');
  });

  it('still reads a 404 as not found', async () => {
    expect((await pauseListing(API, TOKEN, LISTING.id, responds(404))).kind).toBe(
      'not-found',
    );
  });
});

/**
 * The mapping every other caller depends on, asserted here so that adding the
 * `on409` hook cannot have quietly changed it.
 */
describe('the default meaning of a 409', () => {
  it('is still a stale category for callers that supply no hook', async () => {
    const outcome = await publishListing(API, TOKEN, LISTING.id, responds(409));

    expect(outcome.kind).toBe('stale-category');
  });
});
