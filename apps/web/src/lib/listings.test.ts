import { describe, expect, it } from 'vitest';
import {
  createListing,
  fetchCategoryOptions,
  fetchListing,
  fetchOwnedListings,
  fetchListingSearch,
  fetchPublicCategories,
  fetchPublicListing,
  pauseListing,
  publishListing,
  updateListing,
} from './listings';
import type { ListingSearchQuery } from '@platform/contracts';
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
  // Both authorities, because `OwnerListing` carries both from 2.8c-ii and the
  // parse requires them. A fixture that omitted them would make "approved" and
  // "the field failed to serialise" the same thing on the wire.
  moderationState: 'APPROVED',
  moderationReason: null,
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
  // Null and false: a draft that has not said how it is collected, which Â§8.3
  // allows and 2.4c-ii made explicit rather than assumed.
  transportRequirement: null,
  requiresTwoPersonLift: false,
  // Null for the same reason: a draft need not say where the item is either
  // (Â§8.3, slice 2.5a). The field is required to be *present*, so omitting it
  // here would be the compile error that made every caller of this fixture
  // findable in the first place.
  collectionLocation: null,
  // Unpriced, which is what a draft nobody has priced looks like (Â§8.3). The
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

  it('refuses a listing whose moderation state is missing rather than assuming approved', async () => {
    /*
     * Slice 2.8c-ii, and the failure mode worth guarding: an **older API** served
     * to a newer web app.
     *
     * If the field were optional, a response without it would parse and default
     * to nothing â€” and the page would call a listing published and bookable while
     * the platform was hiding it, which is exactly the state this slice exists to
     * end. Required means that mismatch surfaces as `malformed` on a page that
     * says so, rather than as a confident lie.
     */
    const withoutModeration = Object.fromEntries(
      Object.entries(LISTING).filter(([key]) => key !== 'moderationState'),
    );

    const outcome = await fetchListing(
      API,
      TOKEN,
      LISTING.id,
      responds(200, JSON.stringify(withoutModeration)),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('refuses a listing whose moderation reason is missing', async () => {
    // Null is a value here and absence is not. A reason that failed to serialise
    // would otherwise render as "no reason was recorded", which reads to the owner
    // as the platform having hidden their listing without explanation.
    const withoutReason = Object.fromEntries(
      Object.entries(LISTING).filter(([key]) => key !== 'moderationReason'),
    );

    const outcome = await fetchListing(
      API,
      TOKEN,
      LISTING.id,
      responds(200, JSON.stringify(withoutReason)),
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

  it('reports somebody elseâ€™s listing as not-found', async () => {
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
    // better of the two outcomes â€” the same argument the API store makes.
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
 * These had no coverage at this layer before slice H3a â€” the 422 was proven in
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

  it('reads a 503 as the platform switch being off, keeping the APIâ€™s message', () => {
    // Slice H3a, and it was found by pressing the button rather than by a test.
    // The API writes a careful sentence â€” "Publishing is temporarily switched
    // off across the platform. Your listing is saved and unchanged" â€” and
    // before this the owner saw "That did not complete â€” API answered 503",
    // because 503 fell through to the generic unknown-status branch.
    //
    // **The bug was not in the new code.** The kill switch worked perfectly; what
    // it made untrue was this module's assumption about which statuses publish
    // can answer with.
    const message =
      'Publishing is temporarily switched off across the platform. ' +
      'Your listing is saved and unchanged â€” try again shortly.';

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
 * `stale-category` â€” correct for `createListing`, where a conflict really does
 * mean the category moved underneath the form â€” so without a hook of its own, a
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

  it('reads a 409 as a refusal, keeping the APIâ€™s sentence', async () => {
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
 * Editing, and the second 422 in this file (slice 2.9b-ii).
 *
 * **The status is publishing's and the meaning is the opposite**, which is why
 * this module gives it its own kind rather than reusing `not-ready`. Publishing
 * answers 422 to *"this is not finished"*; editing answers it to *"this is
 * already live and your change would break it"*. A form that translated one as
 * the other would tell somebody correcting a typo to go and finish their listing.
 */
describe('updateListing', () => {
  const EDIT = {
    title: 'Petrol hedge trimmer, serviced',
    description: 'Serviced last spring.',
    replacementValue: { amount: 24_999, currency: 'GBP' as const },
    categoryVersionNumber: 1,
    attributes: {},
    transportRequirement: null,
    requiresTwoPersonLift: false,
    rates: { daily: null, weekend: null, weekly: null },
    collectionLocation: null,
  };

  it('returns the updated listing', async () => {
    const outcome = await updateListing(
      API,
      TOKEN,
      LISTING.id,
      EDIT,
      responds(200, JSON.stringify(LISTING)),
    );

    expect(outcome.kind).toBe('loaded');
  });

  it('sends PUT, carrying the whole listing rather than a patch', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(LISTING));
    await updateListing(API, TOKEN, LISTING.id, EDIT, fetchImpl);

    expect(calls[0]?.init?.method).toBe('PUT');
    // The address is in the body even when null â€” "absent" and "clear this"
    // being one value on the wire is exactly what a PATCH would have meant.
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      collectionLocation: null,
    });
  });

  it('reads a 422 as the listing being left incomplete, with its blockers', async () => {
    const outcome = await updateListing(
      API,
      TOKEN,
      LISTING.id,
      EDIT,
      responds(
        422,
        JSON.stringify({
          message:
            'This listing is published, and that change would leave it incomplete.',
          blockers: [
            {
              field: 'collectionLocation',
              message: 'It needs an address before it can be published.',
            },
          ],
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'incomplete',
      blockers: [
        {
          field: 'collectionLocation',
          message: 'It needs an address before it can be published.',
        },
      ],
    });
  });

  it('does not report an incomplete published listing as not-ready', async () => {
    // The assertion the separate kind exists for. Both carry `blockers`, so a
    // shared kind would compile perfectly and say the wrong thing on screen.
    const outcome = await updateListing(
      API,
      TOKEN,
      LISTING.id,
      EDIT,
      responds(422, JSON.stringify({ message: 'x', blockers: [] })),
    );

    expect(outcome.kind).not.toBe('not-ready');
  });

  it('still reads a 409 as a changed category', async () => {
    // Unlike pausing, an edit's 409 really does mean the category moved
    // underneath the form (ADR 0042), so the default mapping is correct here and
    // this pins it against a later hook being added by copy-paste.
    expect(
      (await updateListing(API, TOKEN, LISTING.id, EDIT, responds(409))).kind,
    ).toBe('stale-category');
  });

  it('still reads a 404 as not found', async () => {
    expect(
      (await updateListing(API, TOKEN, LISTING.id, EDIT, responds(404))).kind,
    ).toBe('not-found');
  });
});

/**
 * The unauthenticated read (slice 2.10).
 *
 * **The test that matters is the first one.** Every other function in this file
 * short-circuits to `signed-out` when the token is null, and that guard is
 * exactly wrong here: a signed-out visitor is the expected caller. Routing this
 * through `call` would have shown "your session has expired" to the public, and
 * it would have looked like correct, careful code.
 */
describe('fetchPublicListing', () => {
  const PUBLIC = {
    id: LISTING.id,
    title: 'Petrol hedge trimmer',
    description: 'Serviced last spring.',
    categorySlug: 'outdoor-gardening',
    categoryName: 'Outdoor and gardening',
    categoryAttributes: SCHEMA,
    attributes: { weight_kg: 52 },
    transportRequirement: 'car_boot',
    requiresTwoPersonLift: false,
    location: { outwardCode: 'BS7', town: 'Bristol' },
    inclusiveDailyPrice: {
      rate: { amount: 1_800, currency: 'GBP' },
      renterFee: { amount: 144, currency: 'GBP' },
      total: { amount: 1_944, currency: 'GBP' },
      minimumFeeApplied: false,
    },
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
    // §8.7.2's damage security. Required on the wire, and `null` is the
    // sayable value — so a response that simply omits it is `malformed` rather
    // than a page quietly telling somebody nothing will be held.
    appliedExcess: { amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' },
    // Â§8.3's consumer-law disclosure. Required on the wire, so a response
    // missing it is `malformed` rather than a page that quietly says "private".
    ownerStatus: 'private_owner',
  };

  it('reads a listing with no token at all', async () => {
    const outcome = await fetchPublicListing(
      API,
      LISTING.id,
      responds(200, JSON.stringify(PUBLIC)),
    );

    expect(outcome.kind).toBe('loaded');
  });

  it('sends no authorization header and no client IP', async () => {
    /*
     * The header would be empty anyway â€” there is no token â€” but sending the
     * key at all invites somebody to populate it later. The client IP is absent
     * for its own reason: ADR 0017 forwards it so an audit entry can record who
     * acted, and nothing on this path is audited, so collecting it would be
     * collecting for no purpose (Â§10, data minimisation).
     */
    const { calls, fetchImpl } = capturing(200, JSON.stringify(PUBLIC));
    await fetchPublicListing(API, LISTING.id, fetchImpl);

    const headers = calls[0]?.init?.headers ?? {};
    expect(Object.keys(headers)).toEqual([]);
  });

  it('asks the public path, not the ownerâ€™s', async () => {
    // The two differ by a prefix and return different projections. A call to the
    // owner's path with no token would 401, which is a confusing way to find out
    // the URL was wrong.
    const { calls, fetchImpl } = capturing(200, JSON.stringify(PUBLIC));
    await fetchPublicListing(API, LISTING.id, fetchImpl);

    expect(calls[0]?.url).toContain('/public/listings/');
  });

  it('does not cache, so a paused listing stops being served', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(PUBLIC));
    await fetchPublicListing(API, LISTING.id, fetchImpl);

    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('reads a 404 as not-found, whatever the reason behind it', async () => {
    // Draft, paused, rejected, or no such listing. The API refuses to tell them
    // apart and this refuses to guess.
    expect((await fetchPublicListing(API, LISTING.id, responds(404))).kind).toBe(
      'not-found',
    );
  });

  it('refuses a response that does not match the projection', async () => {
    /*
     * **The projection is what keeps a street address off this page**, so a
     * response this build cannot vouch for is not one to render. Rendering it
     * anyway is how a field nobody reviewed reaches the internet â€” which is the
     * same argument `fetchListing` makes about a missing moderation state, one
     * audience wider.
     */
    const outcome = await fetchPublicListing(
      API,
      LISTING.id,
      responds(200, JSON.stringify({ id: LISTING.id, title: 'Only a title' })),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('reports an unexpected status as unreachable rather than pretending', async () => {
    expect((await fetchPublicListing(API, LISTING.id, responds(500))).kind).toBe(
      'unreachable',
    );
  });

  it('reports a transport failure as unreachable', async () => {
    const outcome = await fetchPublicListing(API, LISTING.id, () =>
      Promise.reject(new Error('socket hang up')),
    );

    expect(outcome).toEqual({ kind: 'unreachable', reason: 'socket hang up' });
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

describe('fetchOwnedListings', () => {
  const ROW = {
    id: LISTING.id,
    title: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    status: 'DRAFT',
    moderationState: 'APPROVED',
    isLocated: false,
    inclusiveDailyPrice: null,
    createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z',
  };

  it('GETs the collection and never reads from a cache', async () => {
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ listings: [ROW], truncated: false }),
    );

    await fetchOwnedListings(API, TOKEN, fetchImpl);

    expect(calls[0]?.url).toBe(`${API}/listings`);
    expect(calls[0]?.init?.method).toBe('GET');
    // A listing somebody has just paused must not come back from a cache saying
    // it is live.
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('returns the page, including whether it was cut', async () => {
    const outcome = await fetchOwnedListings(
      API,
      TOKEN,
      responds(200, JSON.stringify({ listings: [ROW], truncated: true })),
    );

    expect(outcome.kind).toBe('loaded');
    // The whole page rather than only its rows: `truncated` is the one thing the
    // reader has to be told, and returning the array alone would drop it at the
    // one boundary where the loss is invisible.
    expect(outcome.kind === 'loaded' ? outcome.value.truncated : null).toBe(true);
  });

  it('reads an empty list as loaded, not as an error', async () => {
    const outcome = await fetchOwnedListings(
      API,
      TOKEN,
      responds(200, JSON.stringify({ listings: [], truncated: false })),
    );

    // "You have listed nothing" and "we could not read your listings" are
    // different sentences, and this is the boundary where they would be merged.
    expect(outcome).toEqual({
      kind: 'loaded',
      value: { listings: [], truncated: false },
    });
  });

  it('reports an expired session rather than an empty list', async () => {
    expect((await fetchOwnedListings(API, TOKEN, responds(401))).kind).toBe(
      'signed-out',
    );
    expect((await fetchOwnedListings(API, null)).kind).toBe('signed-out');
  });

  it('reports a body it cannot read as malformed', async () => {
    // Rather than as an empty list, which would tell an owner their listings
    // were gone.
    expect(
      (await fetchOwnedListings(API, TOKEN, responds(200, '{"listings":"nope"}'))).kind,
    ).toBe('malformed');
  });
});

describe('fetchListingSearch', () => {
  const RESULTS = {
    results: [
      {
        id: LISTING.id,
        title: 'Petrol hedge trimmer',
        categoryName: 'Outdoor and gardening',
        location: { outwardCode: 'BS7', town: 'Bristol' },
        inclusiveDailyPrice: {
          rate: { amount: 1_800, currency: 'GBP' },
          renterFee: { amount: 144, currency: 'GBP' },
          total: { amount: 1_944, currency: 'GBP' },
          minimumFeeApplied: false,
        },
        distance: { kind: 'under_a_mile' },
        ownerStatus: 'private_owner',
      },
    ],
    truncated: false,
    radiusMiles: 5,
    page: 1,
    category: null,
    dates: null,
    originStatus: 'placed',
  };

  /** One search, defaulted — the shape `fetchListingSearch` takes from 3.2a. */
  const searchFor = (over: Partial<ListingSearchQuery> = {}): ListingSearchQuery => ({
    postcode: 'BS7 8AA',
    radiusMiles: 5,
    page: 1,
    category: null,
    keyword: null,
    dates: null,
    ...over,
  });

  it('reads a page of results with no token at all', async () => {
    const outcome = await fetchListingSearch(
      API,
      searchFor(),
      responds(200, JSON.stringify(RESULTS)),
    );

    expect(outcome.kind).toBe('loaded');
  });

  it('sends no authorization header and no client IP', async () => {
    // Same reasoning as `fetchPublicListing`, and it matters more here: this is
    // the route somebody hits repeatedly while narrowing a search.
    const { calls, fetchImpl } = capturing(200, JSON.stringify(RESULTS));
    await fetchListingSearch(API, searchFor(), fetchImpl);

    expect(Object.keys(calls[0]?.init?.headers ?? {})).toEqual([]);
  });

  it('builds the query string with the contractâ€™s own parameter names', async () => {
    /*
     * The path comes from `publicListingSearchPath`, so the string this sends
     * and the one the API parses are assembled by the same function. Writing it
     * by hand here is how a page comes to disagree with the server about a
     * parameter name â€” and the failure is an empty page rather than an error.
     */
    const { calls, fetchImpl } = capturing(200, JSON.stringify(RESULTS));
    await fetchListingSearch(API, searchFor({ radiusMiles: 20 }), fetchImpl);

    expect(calls[0]?.url).toContain(
      '/public/listings?postcode=BS7%208AA&radiusMiles=20',
    );
  });

  it('does not cache, so a listing taken down stops appearing', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(RESULTS));
    await fetchListingSearch(API, searchFor(), fetchImpl);

    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('reads an empty page as loaded, not as nothing found', async () => {
    // The distinction the page depends on: "we looked and there was nothing"
    // must not arrive looking like "we could not look".
    const outcome = await fetchListingSearch(
      API,
      searchFor(),
      responds(200, JSON.stringify({ ...RESULTS, results: [] })),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      value: {
        results: [],
        truncated: false,
        radiusMiles: 5,
        page: 1,
        category: null,
        keyword: null,
        dates: null,
        originStatus: 'placed',
      },
    });
  });

  it('refuses a response that does not match the projection', async () => {
    // A results page is the version of this data that gets scraped hardest, so
    // a shape this build cannot vouch for is not one to render.
    const outcome = await fetchListingSearch(
      API,
      searchFor(),
      responds(
        200,
        JSON.stringify({ results: [{ id: LISTING.id }], truncated: false }),
      ),
    );

    expect(outcome.kind).toBe('malformed');
  });

  it('carries the page into the query string, and leaves it off the first', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(RESULTS));
    await fetchListingSearch(API, searchFor({ page: 3 }), fetchImpl);
    await fetchListingSearch(API, searchFor(), fetchImpl);

    expect(calls[0]?.url).toContain('page=3');
    // One search, one URL — `?page=1` is a duplicate of the canonical rather
    // than the canonical, which is slice 2.12's problem not to have.
    expect(calls[1]?.url).not.toContain('page');
  });

  /*
   * **The category rides the same builder** (slice 3.2a), so this asserts the
   * one thing a hand-written query string would get wrong: an unfiltered search
   * mints no `category=` at all, and a filtered one carries the slug.
   */
  it('carries the category into the query string, and leaves it off when absent', async () => {
    const { calls, fetchImpl } = capturing(200, JSON.stringify(RESULTS));
    await fetchListingSearch(
      API,
      searchFor({ category: 'outdoor-gardening' }),
      fetchImpl,
    );
    await fetchListingSearch(API, searchFor(), fetchImpl);

    expect(calls[0]?.url).toContain('category=outdoor-gardening');
    expect(calls[1]?.url).not.toContain('category');
  });

  /**
   * The category list (slice 3.2b).
   *
   * **Unauthenticated, like the search beside it.** Browse is the page a
   * signed-out stranger meets first, so a filter needing a token would be a
   * control that only works once you have an account.
   */
  describe('fetchPublicCategories', () => {
    const CATEGORIES = JSON.stringify({
      categories: [{ slug: 'outdoor-gardening', name: 'Outdoor and gardening' }],
    });

    it('reads the list with no token at all', async () => {
      const { calls, fetchImpl } = capturing(200, CATEGORIES);
      const outcome = await fetchPublicCategories(API, fetchImpl);

      expect(calls[0]?.url).toContain('/public/categories');
      expect(Object.keys(calls[0]?.init?.headers ?? {})).toEqual([]);
      expect(outcome).toEqual({
        kind: 'loaded',
        value: [{ slug: 'outdoor-gardening', name: 'Outdoor and gardening' }],
      });
    });

    /*
     * **A failure is an outcome the page turns into "no control"**, never an
     * error it renders. Search does not depend on this read, and a page that
     * refused to show results because a `select` could not be populated would
     * turn a cosmetic outage into a total one.
     */
    it('reports a failure rather than throwing, so the page can carry on', async () => {
      expect((await fetchPublicCategories(API, responds(500))).kind).toBe(
        'unreachable',
      );
      expect((await fetchPublicCategories(API, responds(200, 'not json'))).kind).toBe(
        'malformed',
      );
    });

    it('refuses a response carrying more than a slug and a name', async () => {
      // The disclosure guarantee, checked on the way in as well as on the way
      // out: a server that started sending the attribute schema should surface
      // as a shape this build cannot vouch for.
      const outcome = await fetchPublicCategories(
        API,
        responds(200, JSON.stringify({ categories: [{ slug: 'x' }] })),
      );

      expect(outcome.kind).toBe('malformed');
    });
  });

  it('reads a 400 as unreachable rather than as an empty area', async () => {
    /*
     * The page validates before calling, so a 400 means the two disagree about
     * what is valid. Reporting "nothing near you" would be telling somebody
     * their area is empty when we never managed to look.
     */
    const outcome = await fetchListingSearch(API, searchFor(), responds(400));

    expect(outcome.kind).toBe('unreachable');
  });
});
