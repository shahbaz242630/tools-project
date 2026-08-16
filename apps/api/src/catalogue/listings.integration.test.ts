import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CATEGORY_OPTIONS_PATH,
  LISTINGS_PATH,
  LISTING_STATUSES,
  MAX_SEARCH_PAGE,
  ME_PATH,
  MODERATION_STATES,
  listingPath,
  listingPublicationPath,
  parseCategoryOptions,
  parseOwnedListings,
  parseOwnerListing,
  parsePublicListing,
  parsePublicCategories,
  parsePublicListingSearchResults,
  publicListingPath,
  publicListingSearchPath,
} from '@platform/contracts';
import type { CategoryAttribute, CategoryTransportOption } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { FakeGeocoder } from '../search-location/testing/fakes.js';
import { milesToMetres } from '../search-location/distance-bucket.js';
import { SEARCH_RESULT_LIMIT } from './limits.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from './catalogue.service.js';
import { InMemoryCategoryStore, createListingFakes } from './testing/fakes.js';
import type { ListingFakes } from './testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { createBookingFakes } from '../booking/testing/fakes.js';
import { DEFAULT_MAXIMUM_RENTAL_DAYS } from '@platform/contracts';

/**
 * A priced category (BRD §8.2, §3.4, slice 2.7a).
 *
 * Real rates rather than zeroes: zero is what an unpriced category defaults to,
 * so a suite where every fixture is unpriced could not tell a policy that was
 * carried through from one that was silently dropped.
 */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};

/**
 * Listings through the real application: real routing, real guard, real
 * exception filter.
 *
 * **This file exists mostly to prove two things a service test cannot.** That
 * these routes need no role but do need a session — they are the first
 * authenticated non-administrative surface in the system — and that one owner
 * cannot reach another's listing, which is a property of the query rather than
 * of anything a route says.
 */

const ALICE = { clerkUserId: 'user_alice', sessionId: 'sess_a', email: 'alice@x.com' };
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@x.com' };

/** A schema exercising all four types (ADR 0027), so nothing is untested by luck. */
const SCHEMA: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless battery' },
    ],
  },
  {
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
  },
  {
    key: 'condition_notes',
    label: 'Condition notes',
    required: false,
    type: 'text',
    maxLength: 40,
  },
  {
    key: 'accessories',
    label: 'Accessories',
    required: false,
    type: 'choice-many',
    options: [
      { value: 'case', label: 'Carry case' },
      { value: 'blade', label: 'Spare blade' },
    ],
  },
];

const DRAFT = {
  categorySlug: 'outdoor-gardening',
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
  categoryVersionNumber: 1,
  attributes: { power_source: 'petrol', weight_kg: '5.2' },
  // Null by default: a draft that has not said yet, which §8.3 allows. The
  // transport tests below override it.
  transportRequirement: null,
  requiresTwoPersonLift: false,
  // Null by default too — a draft that has not said where the item is. The
  // collection-address tests below override it.
  collectionLocation: null,
  // Unpriced by default, which §8.3 allows and 2.8 turns into a publication
  // rule. The pricing tests below override it.
  rates: { daily: null, weekend: null, weekly: null },
};

/** A complete collection address, normalised as the contract produces it. */
const ADDRESS = {
  line1: '12 Gloucester Road',
  line2: null,
  town: 'Bristol',
  postcode: 'BS7 8AA',
};

/** What the launch category offers, for the tests that need a category to offer something. */
const TRANSPORT: readonly CategoryTransportOption[] = [
  { requirement: 'car_boot', suggestedUpToKg: 25 },
  { requirement: 'van_required', suggestedUpToKg: 150 },
];

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let listings: ListingFakes;

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  const categories = new InMemoryCategoryStore();
  listings = createListingFakes(categories);

  identity.sessionVerifier.accept('alice-token', ALICE).accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        // A real registry is not wanted here: these tests are about routing and
        // authorisation, and a metrics backend that collected would make two
        // suites in one process share series.
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
          accountData: identity.accountData,
          accountAdmin: identity.accountAdmin,
          roleApprovals: identity.roleApprovals,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(
          categories,
          audit.service,
          createRecordingLogger().logger,
        ),
        featureFlags: createFeatureFlagFakes().service,
        listings: listings.service,
        availability: createBookingFakes().service,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * The mirror row is created just-in-time on first authenticated request, so an
 * owner id only exists once the token has been used once.
 */
async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

/** A category to list in. Created through the store, as an administrator would. */
async function givenACategory(
  slug = 'outdoor-gardening',
  attributes: readonly CategoryAttribute[] = SCHEMA,
  transportOptions: readonly CategoryTransportOption[] = [],
): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.create(
    {
      slug,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes,
      // Empty by default, so every test that is not about transport describes a
      // category that asks nothing about it — which is also what a category
      // configured before slice 2.4c-i is.
      transportOptions,
      feePolicy: FEE_POLICY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
    },
    author,
  );
}

/** Reconfigure it, which mints a version — the thing a stale form races with. */
async function reconfigured(attributes: readonly CategoryAttribute[]): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.addVersion(
    'outdoor-gardening',
    {
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes,
      feePolicy: FEE_POLICY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      transportOptions: [],
    },
    author,
  );
}

/** Rename it, minting a version — the slug stays put and only the label moves. */
async function reconfiguredName(name: string): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.addVersion(
    'outdoor-gardening',
    {
      name,
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: SCHEMA,
      feePolicy: FEE_POLICY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      transportOptions: [],
    },
    author,
  );
}

/** Reprice the category, minting a version — what ADR 0042 makes visible. */
async function reconfiguredWithFee(renterFeeBasisPoints: number): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.addVersion(
    'outdoor-gardening',
    {
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: SCHEMA,
      transportOptions: [],
      feePolicy: { ...FEE_POLICY, renterFeeBasisPoints },
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
    },
    author,
  );
}

function createListing(token = 'alice-token', body: Record<string, unknown> = DRAFT) {
  return app.inject({
    method: 'POST',
    url: LISTINGS_PATH,
    headers: auth(token),
    payload: body,
  });
}

describe('authorisation', () => {
  it('refuses an anonymous caller', async () => {
    expect(
      (await app.inject({ method: 'POST', url: LISTINGS_PATH, payload: DRAFT }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: CATEGORY_OPTIONS_PATH })).statusCode,
    ).toBe(401);
  });

  it('accepts an ordinary signed-in user, with no role at all', async () => {
    // The point of this slice: anybody may rent out a lawnmower. If this ever
    // starts requiring a role, the marketplace has stopped being peer-to-peer.
    await givenACategory();

    expect((await createListing()).statusCode).toBe(201);
  });

  it('refuses a suspended owner the write', async () => {
    // ADR 0024: a suspended person may not change what other people would see.
    await givenACategory();
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    expect((await createListing()).statusCode).toBe(403);
  });

  it('still lets a suspended owner read their own listing', async () => {
    // The other half of ADR 0024: they keep the right to see what we hold.
    await givenACategory();
    const created = parseOwnerListing((await createListing()).json());
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    const response = await app.inject({
      method: 'GET',
      url: listingPath(created.id),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('creating a draft', () => {
  beforeEach(() => givenACategory());

  it('creates it and answers the contract', async () => {
    const response = await createListing();

    expect(response.statusCode).toBe(201);
    const listing = parseOwnerListing(response.json());
    expect(listing.title).toBe('Petrol hedge trimmer');
    expect(listing.status).toBe('DRAFT');
    expect(listing.replacementValue).toEqual({ amount: 24_999, currency: 'GBP' });
  });

  it('pins the category version in force at the time', async () => {
    const response = await createListing();

    expect(parseOwnerListing(response.json()).categoryVersionNumber).toBe(1);
  });

  it('does not echo the owner id back', async () => {
    // Served only to the owner, so their own id says nothing — and it is one
    // fewer field to strip when 2.10 adds the public projection beside it.
    expect((await createListing()).json()).not.toHaveProperty('ownerId');
  });

  it('answers 404 for a category that does not exist', async () => {
    // Not 400: the body is well formed, and the category may have been real
    // when the form was drawn. The fix is to choose again, not to correct a
    // field.
    const response = await createListing('alice-token', {
      ...DRAFT,
      categorySlug: 'no-such-category',
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a replacement value that is a bare number', async () => {
    const response = await createListing('alice-token', {
      ...DRAFT,
      replacementValue: 24_999,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects fractional pence, naming the field', async () => {
    const response = await createListing('alice-token', {
      ...DRAFT,
      replacementValue: { amount: 10.5, currency: 'GBP' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/pence/i);
  });

  it('writes nothing when the body is refused', async () => {
    await createListing('alice-token', { ...DRAFT, title: 'x' });

    expect(listings.listings.all()).toHaveLength(0);
  });

  it('accepts an empty description, because a draft holds progress', async () => {
    const response = await createListing('alice-token', { ...DRAFT, description: '' });

    expect(response.statusCode).toBe(201);
  });

  it('refuses a body with no attributes field at all', async () => {
    // ADR 0025's rule, third outing: an optional field is a silent default, and
    // a caller that forgot the answers should get a 400 rather than a listing
    // that quietly has none.
    const withoutAttributes: Record<string, unknown> = { ...DRAFT };
    delete withoutAttributes.attributes;
    const response = await createListing('alice-token', withoutAttributes);

    expect(response.statusCode).toBe(400);
  });

  it('accepts an empty set of answers, because a draft holds progress', async () => {
    // Both attributes above are `required`, and this still saves. Required
    // means required to *publish* (§8.3, slice 2.8).
    const response = await createListing('alice-token', { ...DRAFT, attributes: {} });

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).attributes).toEqual({});
  });

  it('writes no audit entry, because this is not an administrative action', async () => {
    // §8.13 audits an actor doing something to somebody else, with a reason
    // that person can read. An owner describing their own lawnmower is neither,
    // and a reason nobody reads devalues the ones that matter. There is no
    // route by which anybody else creates a listing — concierge creation was
    // deleted from the BRD on 12 August 2026 — so this holds for every path.
    await createListing();

    expect(
      audit.log.entries().filter((entry) => entry.targetType === 'listing'),
    ).toEqual([]);
  });
});

describe('the answers a category asks for', () => {
  beforeEach(() => givenACategory());

  it('stores them, scaling a number against the category rather than the client', () => {
    // 5.2 kg at one decimal place is 52. The scale comes from the pinned
    // schema, so a client cannot send a value and the scale it means by it.
    return createListing().then((response) => {
      expect(parseOwnerListing(response.json()).attributes).toEqual({
        power_source: 'petrol',
        weight_kg: 52,
      });
    });
  });

  it('returns the schema they were given against, so a value can be read at all', async () => {
    const listing = parseOwnerListing((await createListing()).json());

    expect(listing.categoryAttributes.map((attribute) => attribute.key)).toEqual([
      'power_source',
      'weight_kg',
      'condition_notes',
      'accessories',
    ]);
  });

  it('refuses an answer outside the configured options', async () => {
    const response = await createListing('alice-token', {
      ...DRAFT,
      attributes: { power_source: 'diesel' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/must be one of Petrol, Cordless battery/);
  });

  it('names the field by the label the owner saw, not by its stored key', async () => {
    // `weight_kg` appears nowhere on the form. Prefixing the key — which is what
    // every other contract error in this codebase does, because there the path
    // is the field name — produced "weight_kg: Weight ... " when this was first
    // opened in a browser: the field named twice, once unrecognisably.
    const response = await createListing('alice-token', {
      ...DRAFT,
      attributes: { weight_kg: '5.25' },
    });

    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.[0]).toBe('Weight "5.25" has more than 1 decimal place');
  });

  it('refuses a key the category does not have, rather than dropping it', async () => {
    // Dropping it would throw away something the owner typed with no error.
    const response = await createListing('alice-token', {
      ...DRAFT,
      attributes: { ...DRAFT.attributes, power_supply: 'petrol' },
    });

    expect(response.statusCode).toBe(400);
    expect(
      (response.json() as { issues?: readonly string[] }).issues?.join(' '),
    ).toMatch(/not a field of this category/);
  });

  it('writes nothing when the answers are refused', async () => {
    await createListing('alice-token', {
      ...DRAFT,
      attributes: { power_source: 'diesel' },
    });

    expect(listings.listings.all()).toHaveLength(0);
  });

  it('refuses a bare number, which could not say what scale it meant', async () => {
    const response = await createListing('alice-token', {
      ...DRAFT,
      attributes: { weight_kg: 52 },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('when the category changes while the form is open', () => {
  beforeEach(() => givenACategory());

  it('answers 409, not 400 — nothing they typed is wrong', async () => {
    await reconfigured([...SCHEMA].slice(1));

    const response = await createListing();

    expect(response.statusCode).toBe(409);
    expect((response.json() as { message: string }).message).toMatch(/version 1/);
  });

  it('writes nothing, so the answers are not half-saved', async () => {
    await reconfigured([]);
    await createListing();

    expect(listings.listings.all()).toHaveLength(0);
  });

  it('refuses even when the answers would still have been valid', async () => {
    // The rename is invisible from here: the values happen to fit both schemas.
    // Accepting anyway would mean the *next* rename, the one that does drop an
    // answer, is the first time anybody finds out this check was needed.
    await reconfigured(SCHEMA);

    expect((await createListing()).statusCode).toBe(409);
  });

  it('accepts once the form states the new version', async () => {
    await reconfigured(SCHEMA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      categoryVersionNumber: 2,
    });

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).categoryVersionNumber).toBe(2);
  });

  it('refuses a version that never existed, rather than trusting it', async () => {
    expect(
      (await createListing('alice-token', { ...DRAFT, categoryVersionNumber: 99 }))
        .statusCode,
    ).toBe(409);
  });
});

describe('reading a listing', () => {
  beforeEach(() => givenACategory());

  it('gives the owner their own', async () => {
    const created = parseOwnerListing((await createListing()).json());

    const response = await app.inject({
      method: 'GET',
      url: listingPath(created.id),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(200);
    expect(parseOwnerListing(response.json()).id).toBe(created.id);
  });

  it('answers 404 for somebody else’s, not 403', async () => {
    // 403 would confirm the listing exists, which is the whole thing the
    // ownership check protects. The two failures must be indistinguishable.
    const created = parseOwnerListing((await createListing('alice-token')).json());

    const response = await app.inject({
      method: 'GET',
      url: listingPath(created.id),
      headers: auth('bob-token'),
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a listing that does not exist, identically', async () => {
    const response = await app.inject({
      method: 'GET',
      url: listingPath('00000000-0000-4000-9000-000000000999'),
      headers: auth('bob-token'),
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * Slice 2.9a — the list an owner reads to find their own listings again.
 *
 * **Two things here cannot be proved anywhere else.** That one owner's list
 * never contains another's row — a property of the query, not of anything the
 * route says — and that the response carries the *summary* projection rather
 * than the full one, which is the whole security argument for the slice: an
 * index rendering no addresses must not return one per row.
 */
/**
 * Slice 2.9b-i — rewriting a listing.
 *
 * **Two properties carry the slice**: that editing re-pins to the current version
 * (ADR 0042) while leaving everything the edit does not carry alone, and that the
 * things an edit *cannot* reach stay unreachable — the address, the status, the
 * moderation state and the category.
 */
describe('editing a listing', () => {
  beforeEach(() => givenACategory());

  const EDIT = {
    title: 'Petrol hedge trimmer, serviced',
    description: 'Serviced last spring and sharpened.',
    replacementValue: { amount: 30_000, currency: 'GBP' },
    categoryVersionNumber: 1,
    attributes: { power_source: 'cordless', weight_kg: '4.1' },
    transportRequirement: null,
    requiresTwoPersonLift: true,
    rates: { daily: { amount: 2_000, currency: 'GBP' }, weekend: null, weekly: null },
    /*
     * **Null by default, and it now means "remove the address"** (slice
     * 2.9b-ii). Through 2.9b-i an edit carried no address field at all and the
     * store left the row alone; the field is present on every edit now, so the
     * default has to be one of the real cases. Null matches `DRAFT`'s default,
     * so the listings these tests build have no address before or after.
     *
     * The tests that are about the address override it, below.
     */
    collectionLocation: null,
  };

  function edit(
    id: string,
    token = 'alice-token',
    body: Record<string, unknown> = EDIT,
  ) {
    return app.inject({
      method: 'PUT',
      url: listingPath(id),
      headers: auth(token),
      payload: body,
    });
  }

  async function given(body: Record<string, unknown> = DRAFT) {
    return parseOwnerListing((await createListing('alice-token', body)).json());
  }

  async function reread(id: string) {
    return parseOwnerListing(
      (
        await app.inject({
          method: 'GET',
          url: listingPath(id),
          headers: auth('alice-token'),
        })
      ).json(),
    );
  }

  it('rewrites what the owner wrote', async () => {
    const created = await given();

    const response = await edit(created.id);

    expect(response.statusCode).toBe(200);
    const updated = parseOwnerListing(response.json());
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe('Petrol hedge trimmer, serviced');
    expect(updated.attributes.power_source).toBe('cordless');
    // Scaled by the server against the pinned definition, never by the client
    // (ADR 0029): "4.1" at one decimal place is 41.
    expect(updated.attributes.weight_kg).toBe(41);
    expect(updated.requiresTwoPersonLift).toBe(true);
    expect(updated.rates.daily).toEqual({ amount: 2_000, currency: 'GBP' });
  });

  it('answers 404 for somebody else’s listing, not 403', async () => {
    // 403 would confirm it exists, which is the whole thing ownership protects.
    const created = await given();

    expect((await edit(created.id, 'bob-token')).statusCode).toBe(404);
  });

  it('leaves the other owner’s listing untouched when it refuses', async () => {
    // The refusal above must be a refusal to *write*, not merely a refusal to
    // answer. Asserted from the owner's side, because that is where a silent
    // write would show.
    const created = await given();
    await edit(created.id, 'bob-token');

    expect((await reread(created.id)).title).toBe('Petrol hedge trimmer');
  });

  it('refuses a suspended owner', async () => {
    // ADR 0024: a suspended account may read what we hold and may not write
    // anything others would see. Editing a published listing is exactly that,
    // which is why this sits with publishing rather than with pausing.
    const created = await given();
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    expect((await edit(created.id)).statusCode).toBe(403);
  });

  it('keeps the collection address when the edit sends it back unchanged', async () => {
    /*
     * **What the form does on every save.** It posts back the address it was
     * given, so an owner correcting a title sends the same four values and must
     * get the same address back. The failure worth catching is a round trip that
     * loses `line2`, or normalises the postcode into something else, or drops the
     * lot because nothing changed.
     */
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
    const created = await given({ ...DRAFT, collectionLocation: ADDRESS });
    expect(created.collectionLocation?.postcode).toBe('BS7 8AA');

    const updated = parseOwnerListing(
      (
        await edit(created.id, 'alice-token', { ...EDIT, collectionLocation: ADDRESS })
      ).json(),
    );

    expect(updated.collectionLocation).toEqual(ADDRESS);
    expect(updated.isLocated).toBe(true);
  });

  it('leaves the status alone, so editing does not unpublish', async () => {
    // An owner fixing a typo on a live listing expects it to stay live. Status
    // moves through its own transitions and nowhere else.
    // The category offers no transport options by default, so publication does
    // not require one (2.8a) — and the geocoder has to recognise the postcode,
    // because a listing nothing can place is refused publication.
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
    const created = await given({
      ...DRAFT,
      description: 'Serviced last spring.',
      collectionLocation: ADDRESS,
      rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
    });
    const published = await app.inject({
      method: 'POST',
      url: listingPublicationPath(created.id),
      headers: auth('alice-token'),
    });
    expect(published.statusCode).toBe(201);

    /*
     * **The address and the rates are sent back**, which they were not when this
     * test was written for 2.9b-i — an edit then carried no address, so `EDIT`'s
     * defaults were harmless. From 2.9b-ii they are `null`, and a published
     * listing may not be emptied: this test failed on exactly that when the
     * guard landed, which is the guard doing its job on the first thing it met.
     */
    const updated = parseOwnerListing(
      (
        await edit(created.id, 'alice-token', {
          ...EDIT,
          collectionLocation: ADDRESS,
          rates: {
            daily: { amount: 1_800, currency: 'GBP' },
            weekend: null,
            weekly: null,
          },
        })
      ).json(),
    );

    expect(updated.status).toBe('PUBLISHED');
  });

  it('leaves the moderation state alone', async () => {
    // Not the owner's to set (ADR 0041), and an edit that reset it would be a
    // way to walk out of a refusal by changing a title.
    const created = await given();
    await listings.listings.moderate({
      listingId: created.id,
      state: 'REJECTED',
      reason: 'Not something we can allow on the platform',
      moderatorId: await idOf('bob-token'),
      decidedAt: new Date(),
    });

    const updated = parseOwnerListing((await edit(created.id)).json());

    expect(updated.moderationState).toBe('REJECTED');
    expect(updated.moderationReason).toBe('Not something we can allow on the platform');
  });

  it('re-pins to the category’s current version', async () => {
    /*
     * **ADR 0042's fourth point, and the reason this slice exists at all.** The
     * category is reconfigured; the listing is still on version 1; an edit brings
     * it onto version 2. That is only honest because the form an owner is looking
     * at is built from version 2 — which is what the page does.
     */
    const created = await given();
    expect(created.categoryVersionNumber).toBe(1);

    await reconfigured(SCHEMA);

    const updated = parseOwnerListing(
      (
        await edit(created.id, 'alice-token', { ...EDIT, categoryVersionNumber: 2 })
      ).json(),
    );

    expect(updated.categoryVersionNumber).toBe(2);
  });

  it('refuses an edit built from a version that has since been replaced', async () => {
    /*
     * The stale form, on a route that could not have one before ADR 0042: an edit
     * used to revalidate against the version the listing had already pinned, a
     * row a trigger refuses to update. Now the form is built from the *current*
     * version, so it can be replaced while the page sits open — and accepting the
     * answers anyway would validate them against one schema and pin another.
     */
    const created = await given();
    await reconfigured(SCHEMA);

    const response = await edit(created.id, 'alice-token', {
      ...EDIT,
      categoryVersionNumber: 1,
    });

    expect(response.statusCode).toBe(409);

    // And nothing was written.
    const after = await reread(created.id);
    expect(after.title).toBe('Petrol hedge trimmer');
    expect(after.categoryVersionNumber).toBe(1);
  });

  it('refuses an answer the category does not ask for', async () => {
    const created = await given();

    const response = await edit(created.id, 'alice-token', {
      ...EDIT,
      attributes: { ...EDIT.attributes, invented: 'nonsense' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('takes no category, so a listing cannot be moved between categories', async () => {
    // Not on the schema at all, so zod strips it. Asserted rather than assumed,
    // because the failure would be silent: the listing would keep its category
    // and the caller would believe it had changed.
    const created = await given();

    const updated = parseOwnerListing(
      (
        await edit(created.id, 'alice-token', {
          ...EDIT,
          categorySlug: 'something-else',
        })
      ).json(),
    );

    expect(updated.categorySlug).toBe('outdoor-gardening');
  });

  it('refuses an edit that carries no collection address field at all', async () => {
    // Present-and-nullable, like the create shape: a caller that omitted it has
    // forgotten it, and "leave the address alone" is not something this route
    // can mean — an edit states what happens to every field it owns.
    const created = await given();
    const withoutAddress = Object.fromEntries(
      Object.entries(EDIT).filter(([key]) => key !== 'collectionLocation'),
    );

    expect((await edit(created.id, 'alice-token', withoutAddress)).statusCode).toBe(
      400,
    );
  });

  it('refuses an anonymous caller', async () => {
    const created = await given();

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: listingPath(created.id),
          payload: EDIT,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('writes no audit entry, because an owner editing their own listing is not administrative', async () => {
    // The rule 2.8b settled and 2.8c-i confirmed: the test is *who performed
    // it*. Moderation is the only write in this module performed by somebody
    // who is not the owner, and it is audited.
    const created = await given();
    const before = listings.audit.log.entries.length;

    await edit(created.id);

    expect(listings.audit.log.entries).toHaveLength(before);
  });

  /**
   * Slice 2.9b-ii — changing where an item is collected from.
   *
   * **The whole slice is one rule**: a listing's fuzz offset is drawn once and
   * reused for ever, including across a move (§8.4.1, ADR 0032). Everything else
   * here is arranging for that to be observable, because the thing it prevents
   * has no error, no constraint and no failing test of its own — an owner saving
   * three times would simply publish three points around their house, and the
   * mean of them is the house.
   */
  describe('the collection address', () => {
    const BATH = {
      line1: '4 Mill Lane',
      line2: null,
      town: 'Bath',
      postcode: 'BA1 1AA',
    };

    /** The offset as it is stored, which is what the published point is made from. */
    const offsetOf = async (id: string) =>
      listings.listings.findFuzzOffset(id, await idOf('alice-token'));

    /** A located listing in Bristol, which is where each of these starts. */
    async function givenLocated() {
      listings.geocoder.knows(FakeGeocoder.BS7_8AA).knows(FakeGeocoder.BA1_1AA);
      const created = await given({ ...DRAFT, collectionLocation: ADDRESS });
      expect(created.isLocated).toBe(true);
      return created;
    }

    it('never redraws the fuzz offset, however many times the same address is saved', async () => {
      /*
       * **The assertion this slice exists for, and the one nothing else would
       * catch.** Reusing the create path's `locate` here would draw a fresh
       * offset per save. Nothing would fail: every individual point is a
       * legitimate 500–1000 m displacement, the constraints all hold, and the
       * listing looks correct on screen. What breaks is the *set* of them —
       * average enough and the true point falls out.
       */
      const created = await givenLocated();
      const first = await offsetOf(created.id);
      expect(first).not.toBeNull();

      for (const line1 of ['12 Gloucester Road', '12a Gloucester Road', 'The shed']) {
        const response = await edit(created.id, 'alice-token', {
          ...EDIT,
          collectionLocation: { ...ADDRESS, line1 },
        });
        expect(response.statusCode).toBe(200);
        expect(await offsetOf(created.id)).toEqual(first);
      }
    });

    it('does not even ask the geocoder when the postcode has not changed', async () => {
      /*
       * The offset assertion above would pass whether or not the geocoder was
       * called, because `relocate` reuses the offset either way. This is the
       * other half: a postcode that has not moved is not re-placed at all, so a
       * provider outage cannot strip the coordinates off a listing whose location
       * nobody touched — and an owner fixing a typo does not spend somebody
       * else's service.
       */
      const created = await givenLocated();
      const askedAtCreation = listings.geocoder.asked.length;

      await edit(created.id, 'alice-token', {
        ...EDIT,
        collectionLocation: { ...ADDRESS, line1: 'Rear workshop' },
      });

      expect(listings.geocoder.asked).toHaveLength(askedAtCreation);
    });

    it('moves the listing to a new postcode, keeping the offset it already had', async () => {
      /*
       * **Reusing an offset across a real move discloses nothing** — two true
       * points displaced identically leak only the distance between them, which
       * an attacker watching the listing move already has. Redrawing on an
       * *unchanged* address is what leaks. That asymmetry is the rule, and this
       * is the case where the instinct runs the wrong way.
       */
      const created = await givenLocated();
      const before = await offsetOf(created.id);

      const updated = parseOwnerListing(
        (
          await edit(created.id, 'alice-token', { ...EDIT, collectionLocation: BATH })
        ).json(),
      );

      expect(updated.collectionLocation).toEqual(BATH);
      expect(updated.isLocated).toBe(true);
      expect(await offsetOf(created.id)).toEqual(before);
      expect(listings.geocoder.asked).toContain('BA1 1AA');
    });

    it('draws a first offset for a listing that has never been placed', async () => {
      // The one case that legitimately draws. A draft with no address is being
      // given one, so these coordinates are the first it has ever had — there is
      // no earlier point for a new offset to be inconsistent with.
      listings.geocoder.knows(FakeGeocoder.BS7_8AA);
      const created = await given();
      expect(await offsetOf(created.id)).toBeNull();

      await edit(created.id, 'alice-token', { ...EDIT, collectionLocation: ADDRESS });

      expect(await offsetOf(created.id)).not.toBeNull();
    });

    it('places an address a previous save could not, which is the only retry there is', async () => {
      /*
       * A listing whose postcode was unplaceable has an address and no
       * coordinates, and 2.5b left "save it again" as the only way to fix that.
       * Keying the re-geocode off the postcode alone would have lost it — the
       * postcode has not changed, so nothing would be re-placed, for ever.
       */
      const created = await given({ ...DRAFT, collectionLocation: ADDRESS });
      expect(created.isLocated).toBe(false);

      listings.geocoder.knows(FakeGeocoder.BS7_8AA);
      const updated = parseOwnerListing(
        (
          await edit(created.id, 'alice-token', {
            ...EDIT,
            collectionLocation: ADDRESS,
          })
        ).json(),
      );

      expect(updated.isLocated).toBe(true);
    });

    it('saves a draft whose new postcode cannot be placed', async () => {
      // §8.3 keeps a draft permissive. The address is stored and the listing
      // reads as not located, exactly as it would on creation.
      const created = await givenLocated();

      const updated = parseOwnerListing(
        (
          await edit(created.id, 'alice-token', {
            ...EDIT,
            collectionLocation: { ...BATH, postcode: 'BA1 9ZZ' },
          })
        ).json(),
      );

      expect(updated.collectionLocation?.postcode).toBe('BA1 9ZZ');
      expect(updated.isLocated).toBe(false);
    });

    it('removes the address from a draft', async () => {
      const created = await givenLocated();

      const updated = parseOwnerListing(
        (
          await edit(created.id, 'alice-token', { ...EDIT, collectionLocation: null })
        ).json(),
      );

      expect(updated.collectionLocation).toBeNull();
      expect(updated.isLocated).toBe(false);
    });
  });

  /**
   * What a published listing may not be edited into (slice 2.9b-ii).
   *
   * **The guard that had to arrive with the address.** Publication checks
   * completeness once, when the listing is published, and nothing re-checked it
   * afterwards — so through 2.9b-i an owner could blank a published listing's
   * description and the platform kept showing it. Adding the address would have
   * made that materially worse: a live listing with nowhere to collect from, or
   * one no search can find.
   */
  describe('editing a published listing', () => {
    async function givenPublished() {
      listings.geocoder.knows(FakeGeocoder.BS7_8AA).knows(FakeGeocoder.BA1_1AA);
      const created = await given({
        ...DRAFT,
        collectionLocation: ADDRESS,
        rates: {
          daily: { amount: 1_800, currency: 'GBP' },
          weekend: null,
          weekly: null,
        },
      });
      const published = await app.inject({
        method: 'POST',
        url: listingPublicationPath(created.id),
        headers: auth('alice-token'),
      });
      expect(published.statusCode).toBe(201);
      return created;
    }

    const PUBLISHED_EDIT = {
      ...EDIT,
      collectionLocation: ADDRESS,
      rates: {
        daily: { amount: 1_800, currency: 'GBP' },
        weekend: null,
        weekly: null,
      },
    };

    it('allows an ordinary correction', async () => {
      // The guard refuses *emptying*, not editing. A published listing being
      // corrected is the commonest thing this route will ever do.
      const created = await givenPublished();

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        title: 'Petrol hedge trimmer, freshly serviced',
      });

      expect(response.statusCode).toBe(200);
      expect(parseOwnerListing(response.json()).status).toBe('PUBLISHED');
    });

    it('refuses to leave it with nowhere to collect from', async () => {
      const created = await givenPublished();

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        collectionLocation: null,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        blockers: [{ field: 'collectionLocation' }],
      });
    });

    it('writes nothing at all when it refuses, so the address survives', async () => {
      /*
       * The refusal happens before the store is reached, which matters more than
       * the status code: a listing whose title had been rewritten but whose
       * address had not would be half-saved, and nothing would ever say so.
       */
      const created = await givenPublished();

      await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        title: 'A title that must not stick',
        collectionLocation: null,
      });

      const after = await reread(created.id);
      expect(after.title).toBe('Petrol hedge trimmer');
      expect(after.collectionLocation).toEqual(ADDRESS);
    });

    it('refuses a move to a postcode nothing can place', async () => {
      // A published listing with no point is invisible to search — worse than a
      // refusal, because it looks fine to its owner. The old address survives,
      // so the owner can read the postcode back and see what they typed.
      const created = await givenPublished();

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        collectionLocation: {
          line1: '1 Nowhere',
          line2: null,
          town: 'Bath',
          postcode: 'BA1 9ZZ',
        },
      });

      expect(response.statusCode).toBe(422);
      expect((await reread(created.id)).collectionLocation).toEqual(ADDRESS);
    });

    it('refuses to blank the description, which 2.9b-i allowed', async () => {
      /*
       * **Not the address, and deliberately in scope.** The same hole, one field
       * along: publication requires a description, and until this guard existed
       * an edit could remove one from a live listing. Fixing only the address
       * would have left the next person to find this one by accident.
       */
      const created = await givenPublished();

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        description: '',
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ blockers: [{ field: 'description' }] });
    });

    it('refuses to remove the price', async () => {
      const created = await givenPublished();

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        rates: { daily: null, weekend: null, weekly: null },
      });

      expect(response.statusCode).toBe(422);
    });

    it('lets a paused listing be left incomplete, because nobody can see it', async () => {
      /*
       * The guard keys off `PUBLISHED` rather than "was ever published", and this
       * is the case that shows why. A paused listing is in front of nobody, so
       * there is nothing to protect — and `publish` re-runs the same rules before
       * it can be resumed, which is what makes this safe rather than merely
       * permissive.
       */
      const created = await givenPublished();
      const paused = await app.inject({
        method: 'DELETE',
        url: listingPublicationPath(created.id),
        headers: auth('alice-token'),
      });
      expect(paused.statusCode).toBe(200);

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        collectionLocation: null,
      });

      expect(response.statusCode).toBe(200);
      expect(parseOwnerListing(response.json()).collectionLocation).toBeNull();
    });

    it('says which listing it is talking about, and names pausing as the way out', async () => {
      // The copy carries the whole difference from a publish refusal: this one is
      // already live, and the owner is not being told to finish it.
      const created = await givenPublished();

      const response = await edit(created.id, 'alice-token', {
        ...PUBLISHED_EDIT,
        collectionLocation: null,
      });

      expect(response.json().message).toContain('published');
      expect(response.json().message).toContain('pause');
    });
  });
});

describe('listing everything an owner has', () => {
  beforeEach(() => givenACategory());

  async function listMine(token = 'alice-token') {
    return app.inject({ method: 'GET', url: LISTINGS_PATH, headers: auth(token) });
  }

  it('refuses an anonymous caller', async () => {
    expect((await app.inject({ method: 'GET', url: LISTINGS_PATH })).statusCode).toBe(
      401,
    );
  });

  it('gives somebody with no listings an empty list, not a 404', async () => {
    const response = await listMine();

    expect(response.statusCode).toBe(200);
    const page = parseOwnedListings(response.json());
    expect(page.listings).toEqual([]);
    // The page distinguishes "you have listed nothing" from "we could not read
    // your listings", and a 404 here would collapse the two into the second.
    expect(page.truncated).toBe(false);
  });

  it('returns this owner’s listings and nobody else’s', async () => {
    const mine = parseOwnerListing((await createListing('alice-token')).json());
    await createListing('bob-token');

    const page = parseOwnedListings((await listMine()).json());

    expect(page.listings.map((listing) => listing.id)).toEqual([mine.id]);
  });

  it('newest first', async () => {
    // Determinate here in a way the service test's fake is not: each request is
    // its own transaction, so the timestamps genuinely differ.
    const first = parseOwnerListing((await createListing()).json());
    const second = parseOwnerListing((await createListing()).json());

    const page = parseOwnedListings((await listMine()).json());

    expect(page.listings.map((listing) => listing.id)).toEqual([second.id, first.id]);
  });

  /**
   * **The reason this projection exists**, asserted against the wire rather than
   * against a type.
   *
   * `OwnerListing` carries the decrypted collection address, and a list of
   * twenty would carry twenty homes to render a page that shows none of them.
   * TypeScript cannot catch a controller that returns the wrong mapper — both
   * shapes serialise happily — so the assertion has to be about the JSON that
   * actually left the process.
   */
  it('carries the summary projection, and no collection address', async () => {
    await app.inject({
      method: 'POST',
      url: LISTINGS_PATH,
      headers: auth('alice-token'),
      payload: { ...DRAFT, collectionLocation: ADDRESS },
    });

    const body = (await listMine()).json() as { listings: Record<string, unknown>[] };
    const [row] = body.listings;

    expect(row).toBeDefined();
    // Present, because the page renders them.
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('moderationState');
    expect(row).toHaveProperty('inclusiveDailyPrice');

    // Absent, and each for its own reason (§8.4.1 for the first, weight for the
    // rest). Asserted individually rather than by comparing key sets, so a field
    // added later fails on the one line that names it.
    expect(row).not.toHaveProperty('collectionLocation');
    expect(row).not.toHaveProperty('categoryAttributes');
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('rates');
    expect(row).not.toHaveProperty('moderationReason');

    // And the address really was stored — otherwise this test would pass just as
    // well against a listing that never had one.
    const full = parseOwnerListing(
      (
        await app.inject({
          method: 'GET',
          url: listingPath(String(row?.id)),
          headers: auth('alice-token'),
        })
      ).json(),
    );
    expect(full.collectionLocation?.postcode).toBe('BS7 8AA');
  });

  it('lets a suspended owner read it', async () => {
    // ADR 0024's read half, and it matters more on this route than on the
    // single-listing one: without it a suspended owner cannot *find* the
    // listings they are still permitted to pause.
    await createListing();
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    expect((await listMine()).statusCode).toBe(200);
  });

  it('shows a listing the platform has hidden, with the state that says so', async () => {
    // The 2.8c-ii defect, one surface along. A list that returned `status` alone
    // would show *Published* against a listing nobody can see — and a table is
    // where that is least likely to be noticed.
    const created = parseOwnerListing((await createListing()).json());
    // Through the store rather than the admin route: what is under test is the
    // owner's list, and driving it through `/admin/listings` would drag the role
    // guard and the second-factor claim into a test about a table.
    await listings.listings.moderate({
      listingId: created.id,
      state: 'REJECTED',
      reason: 'Not something we can allow on the platform',
      moderatorId: await idOf('bob-token'),
      decidedAt: new Date(),
    });

    const page = parseOwnedListings((await listMine()).json());

    expect(page.listings[0]?.moderationState).toBe('REJECTED');
    // The reason itself is deliberately not here — it is read on the listing's
    // own page, where the explanation around it lives.
    expect(page.listings[0]).not.toHaveProperty('moderationReason');
  });
});

describe('the categories an owner may list in', () => {
  it('is empty before any category exists, rather than failing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: CATEGORY_OPTIONS_PATH,
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(200);
    expect(parseCategoryOptions(response.json()).categories).toEqual([]);
  });

  it('lists what an owner needs to choose one', async () => {
    await givenACategory();

    const response = await app.inject({
      method: 'GET',
      url: CATEGORY_OPTIONS_PATH,
      headers: auth('alice-token'),
    });

    expect(parseCategoryOptions(response.json()).categories).toEqual([
      {
        slug: 'outdoor-gardening',
        name: 'Outdoor and gardening',
        attributes: SCHEMA,
        transportOptions: [],
        versionNumber: 1,
      },
    ]);
  });

  it('discloses no administrative configuration', async () => {
    // Not `AdminCategory`. The risk level and the reportable-activity flag are
    // how *we* administer a category and an owner picking from a dropdown has
    // no business receiving them — while the attribute schema is exactly what
    // they do need, because it is the form they are about to fill in. The parse
    // above would strip an extra field silently, so this asserts against the
    // raw body instead.
    await givenACategory();

    const response = await app.inject({
      method: 'GET',
      url: CATEGORY_OPTIONS_PATH,
      headers: auth('alice-token'),
    });

    const raw = response.json() as { categories: readonly Record<string, unknown>[] };
    expect(Object.keys(raw.categories[0] ?? {}).sort()).toEqual([
      'attributes',
      'name',
      'slug',
      // The thresholds are here deliberately: the suggestion is computed in the
      // browser as the weight is typed, and they are a hint about how heavy a
      // thing has to be before it needs a van — which is what the form is about
      // to tell the owner anyway. Still no risk level, still no reportable flag.
      'transportOptions',
      'versionNumber',
    ]);
  });
});

describe('the reason there is no audit trail here', () => {
  // Filtered by target rather than counted: the identity module writes its own
  // entries when the mirror row is created on first request, and a bare count
  // would be asserting something about a different module.
  it('records nothing for a read either', async () => {
    await givenACategory();
    const created = parseOwnerListing((await createListing()).json());
    await app.inject({
      method: 'GET',
      url: listingPath(created.id),
      headers: auth('alice-token'),
    });

    expect(
      audit.log.entries().filter((entry) => entry.targetType === 'listing'),
    ).toEqual([]);
  });
});

describe('the transport requirement', () => {
  it('stores what the owner chose from what the category offers', async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);

    const response = await createListing('alice-token', {
      ...DRAFT,
      transportRequirement: 'car_boot',
      requiresTwoPersonLift: true,
    });

    expect(response.statusCode).toBe(201);
    const created = parseOwnerListing(response.json());
    expect(created.transportRequirement).toBe('car_boot');
    expect(created.requiresTwoPersonLift).toBe(true);
  });

  it('accepts a draft that has not said yet', async () => {
    // §8.3's "save progress". Completeness is a publication rule (2.8), so null
    // must not be refused even by a category that offers plenty.
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);

    const response = await createListing('alice-token', {
      ...DRAFT,
      transportRequirement: null,
    });

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).transportRequirement).toBeNull();
  });

  it('demands the field rather than assuming not answered', async () => {
    // ADR 0025's rule, sixth application. A caller that forgot must hear so.
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    const withoutIt = Object.fromEntries(
      Object.entries(DRAFT).filter(([key]) => key !== 'transportRequirement'),
    );

    expect((await createListing('alice-token', withoutIt)).statusCode).toBe(400);
  });

  it('demands the lift flag too', async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    const withoutIt = Object.fromEntries(
      Object.entries(DRAFT).filter(([key]) => key !== 'requiresTwoPersonLift'),
    );

    expect((await createListing('alice-token', withoutIt)).statusCode).toBe(400);
  });

  it('refuses a requirement outside the vocabulary', async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);

    expect(
      (
        await createListing('alice-token', {
          ...DRAFT,
          transportRequirement: 'roof_rack',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses a requirement this category does not offer, and says what it does', async () => {
    // In the vocabulary, so the wire schema is satisfied — and not something this
    // category offers, which only the pinned version can decide.
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);

    const response = await createListing('alice-token', {
      ...DRAFT,
      transportRequirement: 'trailer_required',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    // By label, because the stored values appear nowhere on screen.
    expect(body.issues?.join(' ')).toContain('Car boot');
    expect(body.issues?.join(' ')).toContain('Van or large vehicle');
  });

  it('refuses any requirement when the category asks nothing about collection', async () => {
    // Every category configured before 2.4c-i is in this state, and a listing
    // claiming a requirement its category never offered would be a value nothing
    // downstream could interpret.
    await givenACategory();

    const response = await createListing('alice-token', {
      ...DRAFT,
      transportRequirement: 'car_boot',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/does not ask how an item is collected/i);
  });

  it('writes nothing when the requirement is refused', async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);

    await createListing('alice-token', {
      ...DRAFT,
      transportRequirement: 'trailer_required',
    });

    expect(listings.listings.all()).toHaveLength(0);
  });

  it('offers the category’s options to the form that has to render them', async () => {
    // Without these the field is a dead control: a select with nothing in it.
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);

    const response = await app.inject({
      method: 'GET',
      url: CATEGORY_OPTIONS_PATH,
      headers: auth('alice-token'),
    });

    const [category] = parseCategoryOptions(response.json()).categories;
    expect(category?.transportOptions).toEqual(TRANSPORT);
  });

  it('keeps a listing readable after the category withdraws the option it chose', async () => {
    // ADR 0029's rule, applied to transport: the listing pinned a version whose
    // options included the van, and reconfiguring the category cannot reach back
    // and invalidate that.
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    const created = parseOwnerListing(
      (
        await createListing('alice-token', {
          ...DRAFT,
          transportRequirement: 'van_required',
        })
      ).json(),
    );

    await reconfigured(SCHEMA);

    const response = await app.inject({
      method: 'GET',
      url: listingPath(created.id),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(200);
    expect(parseOwnerListing(response.json()).transportRequirement).toBe(
      'van_required',
    );
  });
});

describe('where the item is collected from', () => {
  it('stores it and gives it back to the owner in full', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: ADDRESS,
    });

    expect(response.statusCode).toBe(201);
    // In full, because this response only ever reaches the owner who typed it.
    expect(parseOwnerListing(response.json()).collectionLocation).toEqual(ADDRESS);
  });

  it('accepts a draft that has not said, because §8.3 lets owners save progress', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: null,
    });

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).collectionLocation).toBeNull();
  });

  it('refuses the field being absent altogether', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    // ADR 0025's rule, for the fourth time on this shape: an optional field is
    // a silent default, and a caller that forgot the address should hear so
    // rather than have "not said" assumed for them.
    const response = await createListing(
      'alice-token',
      Object.fromEntries(
        Object.entries(DRAFT).filter(([key]) => key !== 'collectionLocation'),
      ),
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses a postcode that is not one', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: { ...ADDRESS, postcode: 'NOT A POSTCODE' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses half an address, rather than storing the half it was given', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: { line1: '12 Gloucester Road', line2: null, town: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('normalises the postcode rather than storing what was typed', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    const created = parseOwnerListing(
      (
        await createListing('alice-token', {
          ...DRAFT,
          collectionLocation: { ...ADDRESS, postcode: 'bs7  8aa' },
        })
      ).json(),
    );

    expect(created.collectionLocation?.postcode).toBe('BS7 8AA');
  });

  it('does not give one owner another owner’s address', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    const hers = parseOwnerListing(
      (
        await createListing('alice-token', { ...DRAFT, collectionLocation: ADDRESS })
      ).json(),
    );

    const response = await app.inject({
      method: 'GET',
      url: listingPath(hers.id),
      headers: auth('bob-token'),
    });

    // 404 rather than 403, so the refusal does not confirm the listing exists —
    // and, more to the point here, the body carries no address at all.
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain('Gloucester');
    expect(JSON.stringify(response.json())).not.toContain('BS7');
  });
});

describe('placing the collection address on a map', () => {
  it('locates a postcode the geocoder knows', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: ADDRESS,
    });

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).isLocated).toBe(true);
  });

  it('never returns a coordinate, located or not', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: ADDRESS,
    });

    // BRD §8.4.1: the true coordinate is never returned by any public or
    // pre-booking response, and this is the owner's own — the narrowest one
    // there is. `51.47` and `-2.59` are the real coordinates of BS7 8AA.
    const body = JSON.stringify(response.json());
    expect(body).not.toContain('51.47');
    expect(body).not.toContain('2.59');
  });

  it('saves the draft anyway when the postcode is not recognised', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    // Nothing seeded, so the fake answers "not recognised" — the state a real
    // provider is in for a postcode issued after its last data refresh.

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: ADDRESS,
    });

    // §8.3 makes a draft permissive. Refusing here would mean a valid new-build
    // address cannot be listed until somebody else updates their database.
    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).isLocated).toBe(false);
  });

  it('saves the draft anyway when the geocoder is unreachable', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA).failsOnce();

    const response = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: ADDRESS,
    });

    // A third party being down must not stop somebody listing their lawnmower.
    // If the error propagated this would be a 500.
    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).isLocated).toBe(false);
  });

  it('locates it on a later save, once the provider is back', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA).failsOnce();

    await createListing('alice-token', { ...DRAFT, collectionLocation: ADDRESS });
    const second = await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: ADDRESS,
    });

    // The whole degradation story: the outage costs a listing its coordinates
    // until it is saved again, and nothing has to be repaired by hand.
    expect(parseOwnerListing(second.json()).isLocated).toBe(true);
  });

  it('does not ask the geocoder when there is no address', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    await createListing('alice-token', { ...DRAFT, collectionLocation: null });

    // A draft that has not said where the item is has nothing to geocode, and
    // calling a third party to find that out would be a request that exists
    // only because nobody checked.
    expect(listings.geocoder.asked).toEqual([]);
  });

  it('does not ask the geocoder for a draft it is about to refuse', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);

    await createListing('alice-token', {
      ...DRAFT,
      title: 'x',
      collectionLocation: ADDRESS,
    });

    // Geocoding runs after every validation, deliberately: spending somebody
    // else's service on a draft we are rejecting is rude, and it would make a
    // "title too short" take 2.5 s to arrive whenever the provider is slow.
    expect(listings.geocoder.asked).toEqual([]);
  });

  it('asks with the normalised postcode, not what was typed', async () => {
    await givenACategory('outdoor-gardening', SCHEMA);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);

    await createListing('alice-token', {
      ...DRAFT,
      collectionLocation: { ...ADDRESS, postcode: 'bs7  8aa' },
    });

    // The contract normalises before the service sees it, so the provider is
    // asked one question per postcode rather than one per way of writing it.
    expect(listings.geocoder.asked).toEqual(['BS7 8AA']);
  });
});

/**
 * The price, through the real routes (§3.4.4, §8.5.2, slice 2.7b).
 *
 * What only this level can prove is that the figure is computed **server-side
 * and against the pinned version** — the two properties a unit test of
 * `inclusiveDailyPrice` cannot show, because it is handed both inputs already
 * resolved.
 */
describe('the rate card and the inclusive price', () => {
  beforeEach(() => givenACategory());

  const priced = (rates: Record<string, unknown>) => ({ ...DRAFT, rates });

  /**
   * Slice 2.7c, ADR 0042 — the behaviour the owner actually sees.
   *
   * The database test proves which *row* the policy is read from. This proves
   * that the change reaches the response an owner reads, through the real
   * controller and the real pricing service.
   */
  it('re-prices an existing listing when the category is repriced', async () => {
    const created = parseOwnerListing(
      (
        await createListing(
          'alice-token',
          priced({
            daily: { amount: 1_800, currency: 'GBP' },
            weekend: null,
            weekly: null,
          }),
        )
      ).json(),
    );

    // 8% of £18.00 = £1.44.
    expect(created.inclusiveDailyPrice?.total).toEqual({
      amount: 1_944,
      currency: 'GBP',
    });

    await reconfiguredWithFee(1_600);

    const reread = parseOwnerListing(
      (
        await app.inject({
          method: 'GET',
          url: listingPath(created.id),
          headers: auth('alice-token'),
        })
      ).json(),
    );

    // 16% of £18.00 = £2.88. The owner's own rate is untouched — they set it and
    // nobody else may — and what the renter pays has moved, because the fee is
    // the platform's and is not per-listing.
    expect(reread.rates.daily).toEqual({ amount: 1_800, currency: 'GBP' });
    expect(reread.inclusiveDailyPrice?.total).toEqual({
      amount: 2_088,
      currency: 'GBP',
    });

    // And the pin has not moved, which is the half ADR 0029 still owns: the
    // listing's stored answers are read against version 1 as they always were.
    expect(reread.categoryVersionNumber).toBe(1);
  });

  it('re-prices it on the owner’s list as well as on its own page', async () => {
    // Two mappers build two projections from one record, and a join wired for
    // one of them is how two pages come to disagree about what something costs.
    await createListing(
      'alice-token',
      priced({
        daily: { amount: 1_800, currency: 'GBP' },
        weekend: null,
        weekly: null,
      }),
    );

    await reconfiguredWithFee(1_600);

    const page = parseOwnedListings(
      (
        await app.inject({
          method: 'GET',
          url: LISTINGS_PATH,
          headers: auth('alice-token'),
        })
      ).json(),
    );

    expect(page.listings[0]?.inclusiveDailyPrice?.total).toEqual({
      amount: 2_088,
      currency: 'GBP',
    });
  });

  it('stores the rates and answers with an inclusive daily price', async () => {
    const response = await createListing(
      'alice-token',
      priced({
        daily: { amount: 1_800, currency: 'GBP' },
        weekend: { amount: 3_000, currency: 'GBP' },
        weekly: { amount: 9_000, currency: 'GBP' },
      }),
    );

    expect(response.statusCode).toBe(201);
    const created = parseOwnerListing(response.json());

    expect(created.rates.daily).toEqual({ amount: 1_800, currency: 'GBP' });
    expect(created.rates.weekly).toEqual({ amount: 9_000, currency: 'GBP' });

    // 8% of £18.00 is £1.44, above the £1.00 floor.
    expect(created.inclusiveDailyPrice).toEqual({
      rate: { amount: 1_800, currency: 'GBP' },
      renterFee: { amount: 144, currency: 'GBP' },
      total: { amount: 1_944, currency: 'GBP' },
      minimumFeeApplied: false,
    });
  });

  it('answers no price for an unpriced draft rather than a free one', async () => {
    const response = await createListing();

    expect(response.statusCode).toBe(201);
    const created = parseOwnerListing(response.json());
    expect(created.rates.daily).toBeNull();
    expect(created.inclusiveDailyPrice).toBeNull();
  });

  it('applies the category minimum platform fee on a cheap rate', async () => {
    const response = await createListing(
      'alice-token',
      priced({ daily: { amount: 600, currency: 'GBP' }, weekend: null, weekly: null }),
    );

    const created = parseOwnerListing(response.json());
    // 8% of £6.00 is 48p, below the £1.00 floor, so the floor decides.
    expect(created.inclusiveDailyPrice?.renterFee).toEqual({
      amount: 100,
      currency: 'GBP',
    });
    expect(created.inclusiveDailyPrice?.minimumFeeApplied).toBe(true);
  });

  it('refuses a weekend or weekly rate with no daily rate beside it', async () => {
    const response = await createListing(
      'alice-token',
      priced({
        daily: null,
        weekend: null,
        weekly: { amount: 9_000, currency: 'GBP' },
      }),
    );

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/daily rate is needed/i);
  });

  it('refuses a rate below the platform minimum', async () => {
    const response = await createListing(
      'alice-token',
      priced({ daily: { amount: 99, currency: 'GBP' }, weekend: null, weekly: null }),
    );

    expect(response.statusCode).toBe(400);
  });

  it('demands the rates be present rather than assuming unpriced', async () => {
    // ADR 0025's rule, for the fifth field on this body: an optional value is a
    // silent default, and the silent default here is "this listing has no
    // price" — which a caller that forgot the field would get without hearing
    // about it.
    const response = await createListing(
      'alice-token',
      Object.fromEntries(Object.entries(DRAFT).filter(([key]) => key !== 'rates')),
    );

    expect(response.statusCode).toBe(400);
  });

  /**
   * §3.4.4's actual requirement, asserted as a property rather than as a number:
   * the headline is the sum of what is shown beneath it. A response where they
   * disagreed would be one where some surface could show a total that is not
   * what a renter pays.
   */
  it('always answers a total equal to the sum of its parts', async () => {
    for (const amount of [100, 1_234, 1_800, 9_999]) {
      const created = parseOwnerListing(
        (
          await createListing(
            'alice-token',
            priced({ daily: { amount, currency: 'GBP' }, weekend: null, weekly: null }),
          )
        ).json(),
      );

      const price = created.inclusiveDailyPrice;
      if (price === null) throw new Error('expected a price');
      expect(price.total.amount).toBe(price.rate.amount + price.renterFee.amount);
    }
  });
});

/**
 * Publication, through the real routes (§8.3, slice 2.8a).
 *
 * What only this level proves: that the guard refuses the wrong people, that a
 * refusal is a 422 carrying every blocker, and that the rules are read against
 * the **pinned** version rather than the category as it stands.
 */
describe('publishing a listing', () => {
  beforeEach(async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    // Without this the address never resolves and every listing is blocked on
    // the location rule, which would make every other assertion here vacuous.
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
  });

  /** Everything a listing needs to be publishable, in one body. */
  const READY = {
    ...DRAFT,
    description: 'Serviced last spring. Blade recently sharpened.',
    attributes: { power_source: 'petrol', weight_kg: '5.2' },
    transportRequirement: 'car_boot',
    collectionLocation: ADDRESS,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  };

  const publish = (id: string, token = 'alice-token') =>
    app.inject({
      method: 'POST',
      url: listingPublicationPath(id),
      headers: auth(token),
    });

  async function givenAListing(body: Record<string, unknown> = READY) {
    const response = await createListing('alice-token', body);
    return parseOwnerListing(response.json());
  }

  it('publishes a complete listing', async () => {
    const listing = await givenAListing();
    expect(listing.status).toBe('DRAFT');

    const response = await publish(listing.id);

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).status).toBe('PUBLISHED');
  });

  it('is idempotent, because every state transition is', async () => {
    const listing = await givenAListing();
    await publish(listing.id);

    // Not a 409. Publishing something already published is what a double-click
    // does, and CLAUDE.md makes transitions idempotent.
    const again = await publish(listing.id);
    expect(again.statusCode).toBe(201);
    expect(parseOwnerListing(again.json()).status).toBe('PUBLISHED');
  });

  it('answers 404 for a listing belonging to somebody else', async () => {
    const listing = await givenAListing();

    // Not 403: a stranger must not learn that this listing exists.
    expect((await publish(listing.id, 'bob-token')).statusCode).toBe(404);
  });

  it('answers 404 for a listing that does not exist', async () => {
    expect((await publish('11111111-1111-4111-8111-111111111111')).statusCode).toBe(
      404,
    );
  });

  it('refuses an anonymous caller', async () => {
    const listing = await givenAListing();
    const response = await app.inject({
      method: 'POST',
      url: listingPublicationPath(listing.id),
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * ADR 0024 keeps a suspended account able to read and export its own data.
   * Putting a listing in front of strangers is not reading.
   */
  it('refuses a suspended owner, though they may still read it', async () => {
    const listing = await givenAListing();
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    expect((await publish(listing.id)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: listingPath(listing.id),
          headers: auth('alice-token'),
        })
      ).statusCode,
    ).toBe(200);
  });

  /**
   * The platform-wide kill switch (slice H3a, §9).
   *
   * Distinct from every other refusal in this block: the listing is complete,
   * it is theirs, and they are not suspended. What has changed is the platform.
   */
  describe('when publishing is switched off platform-wide', () => {
    it('refuses with 503, not 422', async () => {
      const listing = await givenAListing();
      listings.publication.off();

      const response = await publish(listing.id);

      // 422 would say "the state of your listing is wrong", and the owner would
      // go looking for a field to fix. Nothing is wrong with their listing.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        message: expect.stringContaining('temporarily switched off') as unknown,
      });
    });

    it('carries no blockers array, so no client renders an empty checklist', async () => {
      const listing = await givenAListing();
      listings.publication.off();

      expect((await publish(listing.id)).json()).not.toHaveProperty('blockers');
    });

    it('leaves the listing exactly as it was', async () => {
      const listing = await givenAListing();
      listings.publication.off();
      await publish(listing.id);

      const read = await app.inject({
        method: 'GET',
        url: listingPath(listing.id),
        headers: auth('alice-token'),
      });
      // Still a draft, still readable, nothing consumed. The refusal copy
      // promises exactly this, so it is worth proving rather than assuming.
      expect(parseOwnerListing(read.json()).status).toBe('DRAFT');
    });

    it('refuses before deciding whether the listing is theirs', async () => {
      // The switch is checked first, so a suspended platform tells everybody the
      // same thing rather than telling a stranger "that is not yours" — the
      // ordering is a disclosure decision as well as a cost one.
      const listing = await givenAListing();
      listings.publication.off();

      expect((await publish(listing.id, 'bob-token')).statusCode).toBe(503);
    });

    it('publishes again once it is switched back on', async () => {
      const listing = await givenAListing();
      listings.publication.off();
      expect((await publish(listing.id)).statusCode).toBe(503);

      listings.publication.on();

      const response = await publish(listing.id);
      expect(response.statusCode).toBe(201);
      expect(parseOwnerListing(response.json()).status).toBe('PUBLISHED');
    });

    /**
     * What the owner's own view says about it (slice H3b).
     *
     * The refusal above is correct and arrives too late to be kind: it is what
     * an owner meets *after* pressing a button the page invited them to press.
     * This is the same fact, offered before.
     */
    describe('what the listing response says', () => {
      it('reports publication as available while the switch is on', async () => {
        const listing = await givenAListing();

        const read = await app.inject({
          method: 'GET',
          url: listingPath(listing.id),
          headers: auth('alice-token'),
        });

        expect(parseOwnerListing(read.json()).publicationAvailable).toBe(true);
      });

      it('reports it as unavailable while the switch is off', async () => {
        const listing = await givenAListing();
        listings.publication.off();

        const read = await app.inject({
          method: 'GET',
          url: listingPath(listing.id),
          headers: auth('alice-token'),
        });

        expect(parseOwnerListing(read.json()).publicationAvailable).toBe(false);
      });

      it('says so on a freshly created draft too', async () => {
        // The create response is an `OwnerListing` like any other, and the page
        // an owner lands on after saving renders from it. A field populated on
        // the read and forgotten on the create would show a working button on
        // exactly the page somebody is most likely to press it from.
        listings.publication.off();

        const created = await createListing();

        expect(created.statusCode).toBe(201);
        expect(parseOwnerListing(created.json()).publicationAvailable).toBe(false);
      });

      it('still refuses a publish attempt from a page that said it was available', async () => {
        // **The field is a courtesy; the 503 is the control.** A page rendered
        // before the switch was thrown reports `true` and its button is enabled,
        // and the API has to refuse anyway — which is why the check exists on
        // both sides and why deleting the server-side one would be a security
        // change rather than a tidy-up.
        const listing = await givenAListing();

        const read = await app.inject({
          method: 'GET',
          url: listingPath(listing.id),
          headers: auth('alice-token'),
        });
        expect(parseOwnerListing(read.json()).publicationAvailable).toBe(true);

        // The switch is thrown after that page was rendered.
        listings.publication.off();

        expect((await publish(listing.id)).statusCode).toBe(503);
      });
    });
  });
});

describe('what publication refuses', () => {
  beforeEach(async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
  });

  const READY = {
    ...DRAFT,
    description: 'Serviced last spring.',
    attributes: { power_source: 'petrol', weight_kg: '5.2' },
    transportRequirement: 'car_boot',
    collectionLocation: ADDRESS,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  };

  async function blockersFor(
    body: Record<string, unknown>,
  ): Promise<readonly string[]> {
    const listing = parseOwnerListing(
      (await createListing('alice-token', body)).json(),
    );
    const response = await app.inject({
      method: 'POST',
      url: listingPublicationPath(listing.id),
      headers: auth('alice-token'),
    });

    // 422, not 400: the request is fine and the listing is not ready.
    expect(response.statusCode).toBe(422);
    const body_ = response.json() as { blockers?: readonly { field: string }[] };
    return (body_.blockers ?? []).map((blocker) => blocker.field);
  }

  it('refuses a listing with no description', async () => {
    expect(await blockersFor({ ...READY, description: '' })).toEqual(['description']);
  });

  it('refuses a listing missing a required attribute', async () => {
    expect(await blockersFor({ ...READY, attributes: { weight_kg: '5.2' } })).toEqual([
      'attributes.power_source',
    ]);
  });

  it('refuses a listing that has not said how it is collected', async () => {
    expect(await blockersFor({ ...READY, transportRequirement: null })).toEqual([
      'transportRequirement',
    ]);
  });

  it('refuses a listing with no daily rate', async () => {
    expect(
      await blockersFor({
        ...READY,
        rates: { daily: null, weekend: null, weekly: null },
      }),
    ).toEqual(['rates.daily']);
  });

  /**
   * Slice 2.5b's rule. The fake geocoder does not recognise this postcode, so
   * the listing saves with an address and no point — a legitimate draft and an
   * illegitimate published listing, because no search could ever return it.
   */
  it('refuses a listing that could not be placed on a map', async () => {
    expect(
      await blockersFor({
        ...READY,
        // Well formed and not seeded, so the fake answers "not recognised" —
        // the state a real provider is in for a postcode issued after its last
        // data refresh. A malformed one would be refused by the contract long
        // before the geocoder saw it, and would prove nothing about this rule.
        collectionLocation: { ...ADDRESS, postcode: 'M3 2LN' },
      }),
    ).toEqual(['collectionLocation']);
  });

  it('refuses a listing with no address at all', async () => {
    expect(await blockersFor({ ...READY, collectionLocation: null })).toEqual([
      'collectionLocation',
    ]);
  });

  /**
   * Every reason at once. An owner fixing one thing per round trip is the small
   * insult that makes people abandon a form.
   */
  it('names every unmet requirement rather than the first', async () => {
    expect(
      await blockersFor({
        ...READY,
        description: '',
        attributes: {},
        transportRequirement: null,
        rates: { daily: null, weekend: null, weekly: null },
        collectionLocation: null,
      }),
    ).toEqual([
      'description',
      'attributes.power_source',
      'attributes.weight_kg',
      'transportRequirement',
      'rates.daily',
      'collectionLocation',
    ]);
  });

  it('leaves the listing a draft when it refuses', async () => {
    const listing = parseOwnerListing(
      (await createListing('alice-token', { ...READY, description: '' })).json(),
    );
    await app.inject({
      method: 'POST',
      url: listingPublicationPath(listing.id),
      headers: auth('alice-token'),
    });

    const reread = parseOwnerListing(
      (
        await app.inject({
          method: 'GET',
          url: listingPath(listing.id),
          headers: auth('alice-token'),
        })
      ).json(),
    );
    expect(reread.status).toBe('DRAFT');
  });

  /**
   * The question slice 2.4c-i deferred, answered end to end: a category offering
   * no transport options means its listings cannot state one, so requiring it
   * would make every listing in that category permanently unpublishable.
   */
  it('does not demand a transport requirement the category never offered', async () => {
    await givenACategory('no-transport', SCHEMA, []);

    const listing = parseOwnerListing(
      (
        await createListing('alice-token', {
          ...READY,
          categorySlug: 'no-transport',
          transportRequirement: null,
        })
      ).json(),
    );

    const response = await app.inject({
      method: 'POST',
      url: listingPublicationPath(listing.id),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).status).toBe('PUBLISHED');
  });

  /**
   * **ADR 0029, and publication is where it would be easiest to break.**
   *
   * The listing is written under version 1, which asks for two attributes. The
   * category then adds a third required attribute, minting version 2. The
   * listing must still publish: it is judged against the terms it was written
   * under, not against a requirement it was never asked for.
   */
  it('judges the listing against its pinned version, not the current one', async () => {
    const listing = await createListing('alice-token', READY);
    const created = parseOwnerListing(listing.json());
    expect(created.categoryVersionNumber).toBe(1);

    await reconfigured([
      ...SCHEMA,
      {
        key: 'serial_number',
        label: 'Serial number',
        required: true,
        type: 'text',
        maxLength: 40,
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: listingPublicationPath(created.id),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(201);
    const published = parseOwnerListing(response.json());
    expect(published.status).toBe('PUBLISHED');
    // And publishing did not re-pin: ADR 0029 makes that an explicit operation,
    // never a side effect of another one.
    expect(published.categoryVersionNumber).toBe(1);
  });
});

/**
 * Pause, resume, and the states in between (§8.3, slice 2.8b).
 *
 * The route is `DELETE` on the publication rather than a `/pause` path, because
 * pausing is removing the publication that `POST` created.
 */
describe('pausing a listing', () => {
  beforeEach(async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
  });

  const READY = {
    ...DRAFT,
    description: 'Serviced last spring. Blade recently sharpened.',
    attributes: { power_source: 'petrol', weight_kg: '5.2' },
    transportRequirement: 'car_boot',
    collectionLocation: ADDRESS,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  };

  const publish = (id: string, token = 'alice-token') =>
    app.inject({
      method: 'POST',
      url: listingPublicationPath(id),
      headers: auth(token),
    });

  const pause = (id: string, token = 'alice-token') =>
    app.inject({
      method: 'DELETE',
      url: listingPublicationPath(id),
      headers: auth(token),
    });

  async function givenAPublishedListing(body: Record<string, unknown> = READY) {
    const listing = parseOwnerListing(
      (await createListing('alice-token', body)).json(),
    );
    await publish(listing.id);
    return listing;
  }

  it('takes a published listing out of public view', async () => {
    const listing = await givenAPublishedListing();

    const response = await pause(listing.id);

    expect(response.statusCode).toBe(200);
    expect(parseOwnerListing(response.json()).status).toBe('PAUSED');
  });

  it('is idempotent, because every state transition is', async () => {
    const listing = await givenAPublishedListing();
    await pause(listing.id);

    const again = await pause(listing.id);

    expect(again.statusCode).toBe(200);
    expect(parseOwnerListing(again.json()).status).toBe('PAUSED');
  });

  it('resumes through POST, because resuming is publishing', async () => {
    const listing = await givenAPublishedListing();
    await pause(listing.id);

    const response = await publish(listing.id);

    expect(response.statusCode).toBe(201);
    expect(parseOwnerListing(response.json()).status).toBe('PUBLISHED');
  });

  it('refuses to pause a draft, with 409 rather than 422', async () => {
    // 422 carries a list of what to fix and invites the owner to fix it. There
    // is nothing to fix here: the listing was never published. A client that
    // could not tell the two apart would render an empty checklist.
    const listing = parseOwnerListing(
      (await createListing('alice-token', READY)).json(),
    );

    const response = await pause(listing.id);

    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.json())).toContain('nothing to pause');
  });

  it('answers 404 for a listing belonging to somebody else', async () => {
    const listing = await givenAPublishedListing();

    // Not 403, and not 409 either — a stranger must not learn that this listing
    // exists, nor what state it is in.
    expect((await pause(listing.id, 'bob-token')).statusCode).toBe(404);
  });

  it('answers 404 for a listing that does not exist', async () => {
    expect((await pause('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const listing = await givenAPublishedListing();

    const response = await app.inject({
      method: 'DELETE',
      url: listingPublicationPath(listing.id),
    });

    expect(response.statusCode).toBe(401);
  });

  /**
   * The asymmetry with publish, asserted rather than described.
   *
   * ADR 0024 stops a suspended account writing anything others would see.
   * Pausing makes others see *less*, and a suspended owner unable to withdraw
   * their own live item would be punished by forced publication.
   */
  it('allows a suspended owner to pause, though not to publish', async () => {
    const listing = await givenAPublishedListing();
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    expect((await pause(listing.id)).statusCode).toBe(200);
    expect((await publish(listing.id)).statusCode).toBe(403);
  });

  /**
   * The kill switch stops listings going public. It has no business stopping
   * one being taken down — an incident is when somebody most needs to.
   */
  it('still pauses while publishing is switched off platform-wide', async () => {
    const listing = await givenAPublishedListing();
    listings.publication.off();

    expect((await pause(listing.id)).statusCode).toBe(200);
    // And the way back is shut, which is the half that proves the switch is
    // still doing its job rather than simply being ignored.
    expect((await publish(listing.id)).statusCode).toBe(503);
  });
});

/**
 * The public listing page's API (slice 2.10).
 *
 * **The first unauthenticated route that returns anything a user wrote**, and
 * the tests here are almost entirely about what it *refuses* to say. Two
 * disclosure rules meet on this route: §8.4.1 keeps the precise address off it,
 * and the uniform 404 keeps the existence of a hidden listing off it. Neither
 * has an error to fail with — a leak here is a 200 with a field too many.
 */
describe('the public listing page', () => {
  beforeEach(async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
  });

  /** A listing complete enough to publish, which is the only kind that shows. */
  const PUBLISHABLE = {
    ...DRAFT,
    description: 'Serviced last spring.',
    attributes: { power_source: 'petrol', weight_kg: '5.2' },
    transportRequirement: 'car_boot',
    collectionLocation: ADDRESS,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  };

  function read(id: string) {
    // **No authorization header at all**, which is the point of the route. A
    // test that passed a token would prove nothing about the case that matters.
    return app.inject({ method: 'GET', url: publicListingPath(id) });
  }

  async function givenVisible() {
    const created = parseOwnerListing(
      (await createListing('alice-token', PUBLISHABLE)).json(),
    );
    const published = await app.inject({
      method: 'POST',
      url: listingPublicationPath(created.id),
      headers: auth('alice-token'),
    });
    expect(published.statusCode).toBe(201);
    return created;
  }

  it('serves a published listing to somebody with no session', async () => {
    const created = await givenVisible();

    const response = await read(created.id);

    expect(response.statusCode).toBe(200);
    const listing = parsePublicListing(response.json());
    expect(listing.id).toBe(created.id);
    expect(listing.title).toBe('Petrol hedge trimmer');
  });

  it('is visible for exactly one of the nine status and moderation pairs', async () => {
    /*
     * **The assertion that ties the SQL to the rule.** `isPubliclyVisible` is
     * the rule and the adapter restates it as two columns, because Phase 3 needs
     * that filter to be indexable. Nothing makes the two agree except this: all
     * nine combinations, one 200.
     *
     * The shape is 2.9a's, which found a branch nothing could reach by testing
     * every pair rather than the three anyone thinks of. Here the failure it
     * guards is worse than a dead branch — `where status = 'PUBLISHED'` alone
     * would serve listings a moderator has rejected, which is the exact
     * sentence `isPubliclyVisible`'s docblock warns about.
     */
    const moderator = await idOf('bob-token');
    const outcomes: string[] = [];

    for (const status of LISTING_STATUSES) {
      for (const state of MODERATION_STATES) {
        const created = parseOwnerListing(
          (await createListing('alice-token', PUBLISHABLE)).json(),
        );

        if (status !== 'DRAFT') {
          await app.inject({
            method: 'POST',
            url: listingPublicationPath(created.id),
            headers: auth('alice-token'),
          });
        }
        if (status === 'PAUSED') {
          await app.inject({
            method: 'DELETE',
            url: listingPublicationPath(created.id),
            headers: auth('alice-token'),
          });
        }
        if (state !== 'APPROVED') {
          await listings.listings.moderate({
            listingId: created.id,
            state,
            reason: 'Checking the serial number against the register',
            moderatorId: moderator,
            decidedAt: new Date(),
          });
        }

        const response = await read(created.id);
        if (response.statusCode === 200) outcomes.push(`${status}/${state}`);
      }
    }

    expect(outcomes).toEqual(['PUBLISHED/APPROVED']);
  });

  it('answers 404 for a listing that does not exist', async () => {
    expect((await read('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  });

  it('says nothing about why a hidden listing is hidden', async () => {
    /*
     * A body that named the moderation state would make this route an audit of
     * our own decisions, readable by anybody with the id — including the person
     * whose listing was rejected working out that a human looked at it.
     */
    const created = await givenVisible();
    await listings.listings.moderate({
      listingId: created.id,
      state: 'REJECTED',
      reason: 'Not something we can allow on the platform',
      moderatorId: await idOf('bob-token'),
      decidedAt: new Date(),
    });

    const response = await read(created.id);

    expect(response.statusCode).toBe(404);
    const body = JSON.stringify(response.json());
    expect(body).not.toContain('REJECTED');
    expect(body).not.toContain('Not something we can allow');
  });

  it('never sends the street lines, the full postcode or a coordinate', async () => {
    /*
     * **Asserted against the wire, not the type.** `PublicListing` and
     * `OwnerListing` both serialise happily, so a route that returned the wrong
     * one would typecheck at every layer and fail only here. `51.47` and `-2.59`
     * are the real coordinates of BS7 8AA.
     */
    const created = await givenVisible();

    const body = JSON.stringify((await read(created.id)).json());

    expect(body).not.toContain('Gloucester');
    expect(body).not.toContain('BS7 8AA');
    expect(body).not.toContain('51.47');
    expect(body).not.toContain('2.59');
    // The district and the town are what it *does* carry.
    expect(body).toContain('BS7');
    expect(body).toContain('Bristol');
  });

  it('never sends the owner, the moderation state or the replacement value', async () => {
    // Each absent for its own reason — see `publicListingSchema`. Asserted
    // together because the failure is the same shape: a field that arrived
    // because it was on the record rather than because the page needs it.
    const created = await givenVisible();

    const body = (await read(created.id)).json() as Record<string, unknown>;

    expect(body).not.toHaveProperty('ownerId');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('moderationState');
    expect(body).not.toHaveProperty('moderationReason');
    expect(body).not.toHaveProperty('replacementValue');
    expect(body).not.toHaveProperty('collectionLocation');
    expect(body).not.toHaveProperty('isLocated');
  });

  it('prices from the category’s current version, not the one it pinned', async () => {
    /*
     * **ADR 0042 on the page it matters most.** §3.4.4 wants the price in the
     * shop window to be the price payable today, and this *is* the shop window.
     * The renter fee goes 8% → 16% and the displayed total must move, without
     * anybody touching the listing — while the owner's own rate does not, since
     * that is theirs and the fee is ours.
     */
    const created = await givenVisible();
    const before = parsePublicListing((await read(created.id)).json());

    await reconfiguredWithFee(1_600);

    const after = parsePublicListing((await read(created.id)).json());

    expect(after.inclusiveDailyPrice.rate).toEqual(before.inclusiveDailyPrice.rate);
    expect(after.inclusiveDailyPrice.total.amount).toBeGreaterThan(
      before.inclusiveDailyPrice.total.amount,
    );
  });

  it('carries the pinned schema, so the answers can be read', async () => {
    // The exit gate of this phase, on a page a stranger reads: the category's
    // own fields travel with the listing, so nothing rendering them has to know
    // what a category contains.
    const created = await givenVisible();

    const listing = parsePublicListing((await read(created.id)).json());

    expect(listing.categoryAttributes.map((one) => one.key)).toContain('weight_kg');
    // Scaled by the server against the pinned definition (ADR 0029): "5.2" at
    // one decimal place is 52.
    expect(listing.attributes.weight_kg).toBe(52);
  });

  it('serves a suspended owner’s listing, because a suspension is not a takedown', async () => {
    /*
     * ADR 0024 stops a suspended account *writing* things others would see. It
     * does not retract what is already published — that is moderation's job, and
     * conflating the two would mean suspending somebody silently unpublished
     * their listings with no moderation record of it.
     */
    const created = await givenVisible();
    identity.users.suspend(await idOf('alice-token'), 'admin-id', 'Repeated no-shows');

    expect((await read(created.id)).statusCode).toBe(200);
  });
});

/**
 * The private-owner or professional-trader declaration (slice 2.13, BRD §8.3).
 *
 * **A consumer-law disclosure, so the tests are about who is told what.** A
 * renter has materially stronger rights against a trader than against a private
 * individual, which is why the platform may not guess and may not publish a
 * listing whose owner has not answered.
 */
describe('how an owner declares themselves', () => {
  beforeEach(async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
  });

  const READY_TO_PUBLISH = {
    ...DRAFT,
    description: 'Serviced last spring.',
    attributes: { power_source: 'petrol', weight_kg: '5.2' },
    transportRequirement: 'car_boot',
    collectionLocation: ADDRESS,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  };

  async function publishAttempt(token = 'alice-token') {
    const created = parseOwnerListing(
      (await createListing(token, READY_TO_PUBLISH)).json(),
    );
    const response = await app.inject({
      method: 'POST',
      url: listingPublicationPath(created.id),
      headers: auth(token),
    });
    return { created, response };
  }

  it('refuses to publish for somebody who has not answered', async () => {
    /*
     * **The gate, and the reason there is no default.** Every other field the
     * completeness rules check is something the owner typed into the listing;
     * this one is about them. Letting it through unanswered would mean
     * publishing an advert that cannot say who the renter is dealing with.
     */
    listings.ownerStatuses.hasNotDeclared(await idOf('alice-token'));

    const { response } = await publishAttempt();

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      blockers: [{ field: 'ownerStatus' }],
    });
  });

  it('tells them why it matters rather than just naming a field', async () => {
    // 2.4b's rule about error copy, on a field whose whole purpose is legal:
    // "ownerStatus is required" would be true and useless.
    listings.ownerStatuses.hasNotDeclared(await idOf('alice-token'));

    const { response } = await publishAttempt();
    const [blocker] = (response.json() as { blockers: { message: string }[] }).blockers;

    expect(blocker?.message).toContain('private individual or as a business');
    expect(blocker?.message).toContain('different rights');
  });

  it('publishes for a declared private individual', async () => {
    listings.ownerStatuses.declares(await idOf('alice-token'), 'private_owner');

    expect((await publishAttempt()).response.statusCode).toBe(201);
  });

  it('refuses to publish for somebody who says they are a business', async () => {
    // Peer-to-peer only, decided 12 August 2026. The listing itself is perfect;
    // what refuses it is who they are, and the message has to say so or they
    // will go looking through their own form for a mistake that is not there.
    listings.ownerStatuses.declares(await idOf('alice-token'), 'professional_trader');

    const { response } = await publishAttempt();
    const [blocker] = (response.json() as { blockers: { message: string }[] }).blockers;

    expect(response.statusCode).toBe(422);
    expect(blocker?.message).toContain('list as a business');
    expect(blocker?.message).toContain('nothing is wrong with the listing itself');
  });

  it('does not refuse a draft — the question is asked at publication', async () => {
    // §8.3 keeps a draft permissive, and this is no different from an address
    // or a price. Somebody writing their first listing should not be sent to
    // their profile before they can save anything at all.
    listings.ownerStatuses.hasNotDeclared(await idOf('alice-token'));

    expect((await createListing('alice-token', READY_TO_PUBLISH)).statusCode).toBe(201);
  });

  describe('what the public page discloses', () => {
    function read(id: string) {
      return app.inject({ method: 'GET', url: publicListingPath(id) });
    }

    async function givenPublished() {
      listings.ownerStatuses.declares(await idOf('alice-token'), 'private_owner');
      const { created, response } = await publishAttempt();
      expect(response.statusCode).toBe(201);
      return created;
    }

    it('states that the owner is a private individual', async () => {
      // The disclosure §8.3 actually asks for, carried on the wire rather than
      // assumed by the page — see `publicListingSchema`.
      const created = await givenPublished();

      const listing = parsePublicListing((await read(created.id)).json());

      expect(listing.ownerStatus).toBe('private_owner');
    });

    it('stops showing the listing if the owner later says they are a business', async () => {
      /*
       * **The hole this closes, and it is the reason the public read checks the
       * declaration rather than trusting publication.** Completeness is settled
       * once, at the moment of publishing, and never looked at again — so
       * without this an owner could publish as a private individual, change
       * their profile, and go on serving a disclosure that had become false.
       *
       * Making visibility depend on the declaration means the disclosure cannot
       * go stale: change the answer and the listing leaves public view until it
       * is changed back.
       */
      const created = await givenPublished();
      expect((await read(created.id)).statusCode).toBe(200);

      listings.ownerStatuses.declares(await idOf('alice-token'), 'professional_trader');

      expect((await read(created.id)).statusCode).toBe(404);
    });

    it('stops showing it if the owner withdraws the declaration entirely', async () => {
      // The positive test — `=== 'private_owner'` — rather than "not a trader".
      // Written as the negative, this case would have slipped through.
      const created = await givenPublished();

      listings.ownerStatuses.hasNotDeclared(await idOf('alice-token'));

      expect((await read(created.id)).statusCode).toBe(404);
    });

    it('says nothing about why it disappeared', async () => {
      // Same uniform 404 as a paused or rejected listing. A stranger must not
      // be able to learn that somebody runs a business from a status code.
      const created = await givenPublished();
      listings.ownerStatuses.declares(await idOf('alice-token'), 'professional_trader');

      const body = JSON.stringify((await read(created.id)).json());

      expect(body).not.toContain('business');
      expect(body).not.toContain('professional_trader');
    });

    it('leaves the owner’s own view of the listing untouched', async () => {
      // Their listing is still theirs and still says PUBLISHED — it is out of
      // public view, not retracted. Anything else would be the platform
      // silently unpublishing on their behalf.
      const created = await givenPublished();
      listings.ownerStatuses.declares(await idOf('alice-token'), 'professional_trader');

      const mine = parseOwnerListing(
        (
          await app.inject({
            method: 'GET',
            url: listingPath(created.id),
            headers: auth('alice-token'),
          })
        ).json(),
      );

      expect(mine.status).toBe('PUBLISHED');
    });
  });
});

describe('searching for listings near a postcode', () => {
  beforeEach(async () => {
    await givenACategory('outdoor-gardening', SCHEMA, TRANSPORT);
    listings.geocoder.knows(FakeGeocoder.BS7_8AA);
  });

  const PUBLISHABLE = {
    ...DRAFT,
    description: 'Serviced last spring.',
    attributes: { power_source: 'petrol', weight_kg: '5.2' },
    transportRequirement: 'car_boot',
    collectionLocation: ADDRESS,
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  };

  function search({
    postcode = 'BS7 8AA',
    radiusMiles = 5 as 5 | 10 | 20 | 50 | 100,
    page = 1,
    category = null as string | null,
    keyword = null as string | null,
  } = {}) {
    // **No authorization header**, which is the whole point of the route. A
    // test that passed a token would prove nothing about the case that matters.
    return app.inject({
      method: 'GET',
      url: publicListingSearchPath({ postcode, radiusMiles, page, category, keyword }),
    });
  }

  /** A published listing, placed a given distance from wherever a search starts. */
  async function givenAListing(
    metresAway: number,
    { token = 'alice-token', categorySlug = 'outdoor-gardening', text = '' } = {},
  ) {
    const created = parseOwnerListing(
      (await createListing(token, { ...PUBLISHABLE, categorySlug })).json(),
    );
    const published = await app.inject({
      method: 'POST',
      url: listingPublicationPath(created.id),
      headers: auth(token),
    });
    expect(published.statusCode).toBe(201);

    /*
     * **The listing is placed *in its category* as well as at a distance**
     * (slice 3.2a). The real query applies both predicates in one statement, so
     * a fake that knew only the distance would let a service that dropped the
     * category filter pass every test here.
     */
    /*
     * **And with its searchable text** (slice 3.3a), for the reason above one
     * filter along. `text` defaults to empty, so a listing created by a test
     * that is not about keywords matches no keyword — which is what makes a
     * keyword test that passes mean something.
     *
     * **This proves the term is passed and applied, and nothing about matching.**
     * The fake's rule is cruder than `websearch_to_tsquery` on purpose;
     * stemming, phrases and punctuation live in
     * `prisma-listing-search.db.test.ts` and can only live there.
     */
    const category = await listings.categories.findBySlug(categorySlug);
    listings.proximity.places(created.id, metresAway, category?.id ?? null, text);
    return created;
  }

  it('returns a listing inside the radius, to somebody with no session', async () => {
    const created = await givenAListing(3_000);

    const response = await search();

    expect(response.statusCode).toBe(200);
    const results = parsePublicListingSearchResults(response.json());
    expect(results.results.map((result) => result.id)).toEqual([created.id]);
  });

  it('leaves out a listing outside the radius', async () => {
    await givenAListing(milesToMetres(8));

    const results = parsePublicListingSearchResults((await search()).json());

    expect(results.results).toEqual([]);
  });

  it('finds it again at a wider radius, which is what the empty state offers', async () => {
    const created = await givenAListing(milesToMetres(8));

    const results = parsePublicListingSearchResults(
      (await search({ radiusMiles: 10 })).json(),
    );

    expect(results.results.map((result) => result.id)).toEqual([created.id]);
  });

  it('says which radius it answered, so a defaulted search is not misread', async () => {
    await givenAListing(3_000);

    const response = await app.inject({
      method: 'GET',
      url: '/public/listings?postcode=BS7%208AA',
    });

    expect(parsePublicListingSearchResults(response.json()).radiusMiles).toBe(5);
  });

  it('orders results nearest first', async () => {
    const far = await givenAListing(6_000);
    const near = await givenAListing(800);

    const results = parsePublicListingSearchResults((await search()).json());

    expect(results.results.map((result) => result.id)).toEqual([near.id, far.id]);
  });

  it('shows a coarse distance and never an exact one', async () => {
    await givenAListing(800);
    await givenAListing(5_000);

    const results = parsePublicListingSearchResults((await search()).json());

    expect(results.results.map((result) => result.distance)).toEqual([
      { kind: 'under_a_mile' },
      { kind: 'approximate', miles: 3 },
    ]);
  });

  it('carries the inclusive price rather than the bare rate (§3.4.4)', async () => {
    await givenAListing(800);

    const results = parsePublicListingSearchResults((await search()).json());

    // 1800 + 8% = 1944, and the card has nowhere to put the 1800 on its own.
    expect(results.results[0]?.inclusiveDailyPrice.total.amount).toBe(1_944);
  });

  it('discloses whether the owner is a private individual (§8.3)', async () => {
    await givenAListing(800);

    const results = parsePublicListingSearchResults((await search()).json());

    expect(results.results[0]?.ownerStatus).toBe('private_owner');
  });

  it('asks Profiles once for the whole page, not once per owner', async () => {
    /*
     * **The N+1 the August 2026 audit found.** Hydration used to resolve each
     * distinct owner with its own call across the module boundary — cheap at
     * three fixtures and one query per owner on a page of twenty-four, on the
     * one public route that returns a collection and has no rate limit in front
     * of it.
     *
     * This is invisible in the response: the fixed and the broken version
     * return identical JSON, which is why it is asserted on the port rather
     * than on the body. Two owners, three listings — so a service that batched
     * by *listing* rather than by owner would still fail.
     */
    await givenAListing(800);
    await givenAListing(1_200);
    await givenAListing(2_000, { token: 'bob-token' });

    // Publication asks the same question, so counting starts once the fixtures
    // exist — otherwise this measures the setup.
    listings.ownerStatuses.forgetLookups();

    const results = parsePublicListingSearchResults((await search()).json());
    expect(results.results).toHaveLength(3);

    expect(listings.ownerStatuses.lookups).toHaveLength(1);
    // Sorted rather than ordered: the ids come from the hydration query, whose
    // order is the store's business and not something this test should pin.
    expect([...(listings.ownerStatuses.lookups[0] ?? [])].sort()).toEqual(
      [await idOf('alice-token'), await idOf('bob-token')].sort(),
    );
  });

  describe('what a search must never return', () => {
    it('leaves out a listing its owner never published', async () => {
      const created = parseOwnerListing(
        (await createListing('alice-token', PUBLISHABLE)).json(),
      );
      // Placed as if it were nearby — which is exactly the state ADR 0044's
      // re-check exists for: proximity says yes, visibility says no, and the
      // store is what has to refuse.
      listings.proximity.places(created.id, 800);

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toEqual([]);
    });

    it('leaves out a listing a moderator has rejected', async () => {
      const created = await givenAListing(800);
      await listings.listings.moderate({
        listingId: created.id,
        state: 'REJECTED',
        reason: 'Prohibited item',
        moderatorId: await idOf('bob-token'),
        decidedAt: new Date(),
      });

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toEqual([]);
    });

    it('leaves out a listing whose owner now says they are a business', async () => {
      // The third visibility authority (ADR 0043), applied on hydration rather
      // than in the geo query (ADR 0044). It has to work, or a legal disclosure
      // that has gone stale goes on being served from a results page.
      await givenAListing(800);
      listings.ownerStatuses.declares(await idOf('alice-token'), 'professional_trader');

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toEqual([]);
    });

    it('leaves out a listing whose owner has never declared', async () => {
      await givenAListing(800);
      listings.ownerStatuses.hasNotDeclared(await idOf('alice-token'));

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toEqual([]);
    });

    /*
     * **2.10's disclosure test, applied to a collection.** A results page is the
     * version of this data that gets scraped hardest, so the assertion is
     * against the whole serialised response rather than against named fields: a
     * field added to the projection by somebody in a hurry fails here.
     */
    it('discloses no street line, no full postcode and no coordinate', async () => {
      await givenAListing(800);

      const body = JSON.stringify((await search()).json());

      expect(body).toContain('BS7');
      expect(body).toContain('Bristol');
      expect(body).not.toContain(ADDRESS.line1);
      expect(body).not.toContain(ADDRESS.postcode);
      expect(body).not.toContain('latitude');
      expect(body).not.toContain('longitude');
      expect(body).not.toContain(String(FakeGeocoder.BS7_8AA.latitude));
      expect(body).not.toContain(String(FakeGeocoder.BS7_8AA.longitude));
    });

    it('says nothing about moderation, drafts, the owner or the description', async () => {
      await givenAListing(800);

      const body = JSON.stringify((await search()).json());

      expect(body).not.toContain('moderationState');
      expect(body).not.toContain('ownerId');
      expect(body).not.toContain('Serviced last spring.');
    });
  });

  describe('what it refuses', () => {
    it('rejects a malformed postcode rather than reporting an empty area', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=not-a-postcode',
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a radius that is not one of the five', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=BS7%208AA&radiusMiles=7',
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a missing postcode', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/public/listings?radiusMiles=5',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('an origin nothing can place', () => {
    it('is an empty page rather than an error', async () => {
      // A valid postcode the geocoder does not recognise, or a geocoder that is
      // briefly down. Neither is the searcher's fault and neither is a 5xx.
      await givenAListing(800);
      listings.proximity.cannotPlace('BS7 8AA');

      const response = await search();

      expect(response.statusCode).toBe(200);
      const results = parsePublicListingSearchResults(response.json());
      expect(results.results).toEqual([]);
      expect(results.truncated).toBe(false);
    });

    /**
     * **The test that fails without the fix, at the HTTP boundary.**
     *
     * The empty page above is correct and stays correct — a well-formed postcode
     * is not a 400, and a provider outage is not our 500. What was wrong is that
     * the response said nothing else, so `{ results: [] }` here was byte-identical
     * to `{ results: [] }` from a genuinely quiet area, and Browse rendered the
     * outage as *"There is nothing listed near you yet. We are just getting
     * started"*. Confirmed in a browser on staging.
     *
     * **Asserted at the route rather than on the service** deliberately, and for
     * the reason slice 3.1f gives about its own counters: this distinction had
     * been available on the service since 3.1a — it returns null — and died in the
     * controller, which is precisely the layer a service-level test cannot see.
     * The listing seeded a metre away is the teeth: it is inside the radius and
     * must still not come back, so nothing here can pass by accidentally finding
     * nothing.
     */
    it('says it could not place the origin, rather than implying an empty area', async () => {
      await givenAListing(800);
      listings.proximity.cannotPlace('BS7 8AA');

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.originStatus).toBe('unplaceable');
    });

    it('still echoes the radius, page and category it was asked about', async () => {
      /*
       * The page has to keep drawing its own form and its own links from this
       * response, so a search that could not run still has to say what was asked
       * — otherwise correcting a postcode would silently drop the radius and the
       * filter the searcher had already chosen.
       */
      listings.proximity.cannotPlace('BS7 8AA');

      const results = parsePublicListingSearchResults(
        (await search({ radiusMiles: 20, category: 'outdoor-gardening' })).json(),
      );

      expect(results.radiusMiles).toBe(20);
      expect(results.category).toBe('outdoor-gardening');
      expect(results.page).toBe(1);
      expect(results.originStatus).toBe('unplaceable');
    });
  });

  /**
   * The other half of the same distinction, and the half that is easy to leave
   * untested.
   *
   * A field that only ever reports failure is one nobody notices is stuck; these
   * pin that a search which *did* run says so, whether or not it found anything.
   * The second case is the one that carries the meaning — an empty result with
   * `placed` is the platform saying "we looked, and there is nothing", which is
   * the only circumstance in which the page is entitled to say so.
   */
  describe('an origin it could place', () => {
    it('says the origin was placed when it found something', async () => {
      await givenAListing(800);

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toHaveLength(1);
      expect(results.originStatus).toBe('placed');
    });

    it('says the origin was placed even when the radius is empty', async () => {
      // The combination the whole field exists to separate from the one above:
      // no results, and they mean something.
      await givenAListing(milesToMetres(8));

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toEqual([]);
      expect(results.originStatus).toBe('placed');
    });
  });

  /**
   * What the platform can say about its own searches (slice 3.1f).
   *
   * **Every one of these outcomes is served as a 200 with a list**, which is why
   * they need counting separately: the request metrics H1 already collects
   * cannot tell any of them apart, so before this slice "nobody is finding
   * anything" and "our geocoder is down" and "the marketplace is busy" all
   * looked identical from outside.
   *
   * The assertions are at the HTTP boundary on purpose. Recording is easy to put
   * somewhere that a controller then makes unreachable — the `unplaceable` case
   * is exactly that shape, since the controller collapses it into an empty page
   * — so the test drives the route a stranger drives.
   */
  describe('what the search recorded', () => {
    it('counts a search that found something, with the radius it used', async () => {
      await givenAListing(3_000);

      await search({ radiusMiles: 20 });

      expect(listings.metrics.listingSearches).toEqual([
        { radiusMiles: 20, outcome: 'found', filtered: false, keyworded: false },
      ]);
    });

    it('counts an area with nothing in it as empty', async () => {
      /*
       * **The single most valuable number here.** BRD §17 names low inventory
       * density as the dominant failure mode of local marketplaces, and until
       * this existed we could not say what fraction of searches find nothing.
       */
      await givenAListing(milesToMetres(8));

      await search();

      expect(listings.metrics.listingSearches).toEqual([
        { radiusMiles: 5, outcome: 'empty', filtered: false, keyworded: false },
      ]);
    });

    it('counts an unplaceable origin apart from an empty area', async () => {
      /*
       * **The one the controller would have hidden.** An origin we cannot place
       * is served as an empty page — deliberately, since a searcher is owed one
       * answer rather than a diagnosis of our provider — so a counter at the
       * route could never tell this from a quiet area. Which means our own
       * geocoding provider going down would read as "nobody has anything near
       * you", indefinitely, with nothing to alert on.
       */
      await givenAListing(800);
      listings.proximity.cannotPlace('BS7 8AA');

      await search();

      expect(listings.metrics.listingSearches).toEqual([
        { radiusMiles: 5, outcome: 'unplaceable', filtered: false, keyworded: false },
      ]);
    });

    it('does not count a page past the end as a zero-result search', async () => {
      /*
       * Somebody on page four of a one-page result found plenty. Folding that
       * into `empty` would report a navigation artefact as missing inventory,
       * corrupting the one number this whole metric exists to produce.
       */
      await givenAListing(3_000);

      await search({ page: 4 });

      expect(listings.metrics.listingSearches).toEqual([
        { radiusMiles: 5, outcome: 'beyond_end', filtered: false, keyworded: false },
      ]);
    });

    it('records nothing at all for a request it refused', async () => {
      // A radius of 7 and a malformed postcode never reach the service, so they
      // are not searches — counting them would put caller error into the
      // zero-result rate. They are already visible as 4xx on the route metric.
      await givenAListing(800);

      await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=BS7%208AA&radiusMiles=7',
      });
      await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=not-a-postcode',
      });

      expect(listings.metrics.listingSearches).toEqual([]);
    });

    /*
     * **A category we do not have is a refusal, so it is not a search either**
     * (slice 3.2a). It is the same rule as the radius of 7 one line up, and it
     * is worth its own test because the refusal happens a layer deeper — inside
     * the service rather than in the query parser — which is exactly where a
     * counter could have been placed before the throw.
     */
    it('records nothing for a category it refused', async () => {
      await givenAListing(800);

      const response = await search({ category: 'no-such-category' });

      expect(response.statusCode).toBe(400);
      expect(listings.metrics.listingSearches).toEqual([]);
    });

    /*
     * **Whether, never which** — the cardinality rule as a test. A category slug
     * is configuration, so a label carrying one is a series count an
     * administrator grows through a form.
     */
    it('marks a filtered search without recording which category', async () => {
      await givenAListing(800);

      await search({ category: 'outdoor-gardening' });

      expect(listings.metrics.listingSearches).toEqual([
        { radiusMiles: 5, outcome: 'found', filtered: true, keyworded: false },
      ]);
      expect(JSON.stringify(listings.metrics.listingSearches)).not.toContain(
        'outdoor-gardening',
      );
    });

    /*
     * **The same rule for the search term, and it is the one that matters most**
     * (slice 3.3a). A category slug is at least a set an administrator created;
     * a search term is whatever a stranger typed, so it is the only thing this
     * system could label with that is unbounded, free text *and* public-supplied.
     * The term used here is deliberately something that would be alarming to
     * find in a metrics registry.
     */
    it('marks a keyworded search without recording the words', async () => {
      await givenAListing(800);

      await search({ keyword: 'hedge trimmer BS7 8AA' });

      expect(listings.metrics.listingSearches).toEqual([
        { radiusMiles: 5, outcome: 'empty', filtered: false, keyworded: true },
      ]);

      const recorded = JSON.stringify(listings.metrics.listingSearches);
      expect(recorded).not.toContain('hedge');
      expect(recorded).not.toContain('trimmer');
      expect(recorded).not.toContain('BS7');
    });

    it('counts the geocode as well as the search, through one shared helper', async () => {
      /*
       * The search path reaches the geocoder through `geocodeQuietly`, the same
       * function the write path uses — so a provider outage is one series
       * whichever half of the platform hit it. Here the fake proximity answers
       * without a real geocoder, so what this pins is the *listing* geocode from
       * publishing: the recording is not confined to one path by accident.
       */
      await givenAListing(3_000);

      expect(listings.metrics.geocodes.map((sample) => sample.outcome)).toContain(
        'found',
      );
    });

    it('does not let a broken metrics backend fail a search', async () => {
      /*
       * The rule the Fastify hook already follows, applied one layer in: a
       * diagnostic must never be able to fail the thing it is watching. Without
       * the guard this is a 500 on the most public route in the system.
       */
      const created = await givenAListing(3_000);
      listings.metrics.metrics.recordListingSearch = () => {
        throw new Error('registry exploded');
      };

      const response = await search();

      expect(response.statusCode).toBe(200);
      expect(
        parsePublicListingSearchResults(response.json()).results.map(
          (result) => result.id,
        ),
      ).toEqual([created.id]);
    });
  });

  describe('when there are more than fit on a page', () => {
    it('says so rather than stopping quietly', async () => {
      // One more than the page size, which is the only case where a full page
      // and a complete set are indistinguishable without being told.
      for (let index = 0; index <= SEARCH_RESULT_LIMIT; index += 1) {
        await givenAListing(100 + index);
      }

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toHaveLength(SEARCH_RESULT_LIMIT);
      expect(results.truncated).toBe(true);
    });

    it('does not claim truncation on an exactly full page', async () => {
      for (let index = 0; index < SEARCH_RESULT_LIMIT; index += 1) {
        await givenAListing(100 + index);
      }

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results).toHaveLength(SEARCH_RESULT_LIMIT);
      expect(results.truncated).toBe(false);
    });
  });

  /**
   * Narrowing to a category (slice 3.2a) — BRD §8.4's second filter.
   *
   * Driven at the route a stranger drives, because the slug→id resolution is
   * the part that has no other home: the contract can only tell whether a slug
   * is *shaped* like one, and the repository is handed an id it never has to
   * question. Only this path exercises the step between them.
   */
  describe('narrowing to a category', () => {
    beforeEach(async () => {
      await givenACategory('power-tools', SCHEMA, TRANSPORT);
    });

    it('returns only listings in the category asked for', async () => {
      const wanted = await givenAListing(800, { categorySlug: 'outdoor-gardening' });
      await givenAListing(900, { categorySlug: 'power-tools' });

      const results = parsePublicListingSearchResults(
        (await search({ category: 'outdoor-gardening' })).json(),
      );

      expect(results.results.map((result) => result.id)).toEqual([wanted.id]);
    });

    it('returns every category when none is asked for', async () => {
      const near = await givenAListing(800, { categorySlug: 'outdoor-gardening' });
      const far = await givenAListing(900, { categorySlug: 'power-tools' });

      const results = parsePublicListingSearchResults((await search()).json());

      expect(results.results.map((result) => result.id)).toEqual([near.id, far.id]);
    });

    /*
     * **The response says which question it answered**, the same reason the
     * radius and the page are echoed. An unfiltered search that looked filtered
     * would make a supply problem read as a filter problem.
     */
    it('echoes the category it filtered by, as the slug', async () => {
      await givenAListing(800);

      const filtered = parsePublicListingSearchResults(
        (await search({ category: 'outdoor-gardening' })).json(),
      );
      const unfiltered = parsePublicListingSearchResults((await search()).json());

      expect(filtered.category).toBe('outdoor-gardening');
      expect(unfiltered.category).toBeNull();
    });

    /*
     * **A 400, and the alternative is the one wrong answer available.** Serving
     * an empty page would tell somebody there is nothing near them in a category
     * we have never had — indistinguishable from a genuinely quiet area, and
     * counted as one.
     */
    it('refuses a slug that names no category rather than searching every category', async () => {
      const created = await givenAListing(800);

      const response = await search({ category: 'no-such-category' });

      expect(response.statusCode).toBe(400);
      // The listing is findable — so the refusal is about the category, not
      // about there being nothing to find.
      const results = parsePublicListingSearchResults((await search()).json());
      expect(results.results.map((result) => result.id)).toEqual([created.id]);
    });

    it('refuses a malformed slug in the same words as an unknown one', async () => {
      const malformed = await search({ category: 'Not A Slug' });
      const unknown = await search({ category: 'no-such-category' });

      expect(malformed.statusCode).toBe(400);
      expect(unknown.statusCode).toBe(400);
      // For a searcher the two are one fact, and the message says so — see
      // `SEARCH_CATEGORY_MESSAGE`.
      expect(malformed.json().message).toContain('is not a category we have');
      expect(unknown.json().message).toContain('is not a category we have');
    });

    /*
     * **An empty `category=` is every category, not a bad request** — the case a
     * plain GET form produces the moment 3.2b gives this filter a `select` with
     * an "All categories" option. Asserted here rather than only in the contract
     * because it is the whole route that has to survive it.
     */
    it('treats an empty category parameter as no filter', async () => {
      const created = await givenAListing(800);

      const response = await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=BS7%208AA&radiusMiles=5&category=',
      });

      expect(response.statusCode).toBe(200);
      const results = parsePublicListingSearchResults(response.json());
      expect(results.results.map((result) => result.id)).toEqual([created.id]);
      expect(results.category).toBeNull();
    });

    /*
     * **The filter reaches the query rather than being applied afterwards.**
     * Asserting on results alone cannot tell "the filter was passed and matched
     * everything" from "the filter was never passed" — which is why the fake
     * records what it was asked to narrow to.
     */
    it('passes the resolved category id down to the query, not the slug', async () => {
      await givenAListing(800);
      const category = await listings.categories.findBySlug('outdoor-gardening');

      await search({ category: 'outdoor-gardening' });

      expect(listings.proximity.categories).toEqual([category?.id]);
    });

    it('passes null down when nothing was asked for', async () => {
      await givenAListing(800);

      await search();

      expect(listings.proximity.categories).toEqual([null]);
    });
  });

  /**
   * Narrowing to words (slice 3.3a).
   *
   * **What this describe block can prove, and what it cannot.** It proves the
   * route accepts the parameter, that the parsed term reaches the query, that
   * the response says which words it answered, and that nothing about it is a
   * refusal. It proves **nothing** about matching — the proximity fake's rule is
   * deliberately cruder than `websearch_to_tsquery`, and the real semantics live
   * in `prisma-listing-search.db.test.ts` against a real Postgres.
   */
  describe('narrowing to words', () => {
    it('returns only listings whose text matches', async () => {
      const wanted = await givenAListing(800, { text: 'petrol hedge trimmer' });
      await givenAListing(900, { text: 'sds rotary hammer drill' });

      const results = parsePublicListingSearchResults(
        (await search({ keyword: 'trimmer' })).json(),
      );

      expect(results.results.map((result) => result.id)).toEqual([wanted.id]);
    });

    /*
     * **The response says which words it answered**, the radius's reason again
     * and sharper: a page reading "nothing near you" when a keyword was applied
     * is a claim about the area made on the evidence of one search term.
     */
    it('echoes the keyword it searched for', async () => {
      await givenAListing(800, { text: 'petrol hedge trimmer' });

      const keyworded = parsePublicListingSearchResults(
        (await search({ keyword: 'trimmer' })).json(),
      );
      const plain = parsePublicListingSearchResults((await search()).json());

      expect(keyworded.keyword).toBe('trimmer');
      expect(plain.keyword).toBeNull();
    });

    /*
     * **Trimmed on the way in and echoed trimmed**, so the page cannot display
     * one thing while the query was asked another — and so the pager's links,
     * which are built from the echo, describe the search that actually ran.
     */
    it('echoes the trimmed keyword, which is the one that ran', async () => {
      await givenAListing(800, { text: 'petrol hedge trimmer' });

      const results = parsePublicListingSearchResults(
        (await search({ keyword: '  trimmer  ' })).json(),
      );

      expect(results.keyword).toBe('trimmer');
      expect(listings.proximity.keywords).toEqual(['trimmer']);
    });

    /*
     * **An empty `keyword=` is no keyword, not a bad request** — the case Browse
     * will produce on every unkeyworded search the moment 3.3b gives this filter
     * a text input, because a plain GET form submits every named control.
     */
    it('treats an empty keyword parameter as no keyword', async () => {
      const created = await givenAListing(800);

      const response = await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=BS7%208AA&radiusMiles=5&keyword=',
      });

      expect(response.statusCode).toBe(200);
      const results = parsePublicListingSearchResults(response.json());
      expect(results.results.map((result) => result.id)).toEqual([created.id]);
      expect(results.keyword).toBeNull();
    });

    /*
     * **Words naming nothing are an empty page, never a 400** — and this is the
     * deliberate difference from the category filter beside it. An unknown
     * category slug is refused because it describes a search we do not serve; a
     * word we hold no listing for describes a search we serve perfectly well and
     * that simply found nothing. Refusing it would be telling somebody their
     * question was malformed when it was merely unlucky.
     */
    it('answers words that match nothing with an empty page rather than a refusal', async () => {
      await givenAListing(800, { text: 'petrol hedge trimmer' });

      const response = await search({ keyword: 'xylophone' });

      expect(response.statusCode).toBe(200);
      const results = parsePublicListingSearchResults(response.json());
      expect(results.results).toEqual([]);
      expect(results.originStatus).toBe('placed');
    });

    /*
     * **Nothing a person can type is refused for its content.** The contract
     * bounds the length and nothing else — see `searchKeywordSchema` — because
     * `websearch_to_tsquery` accepts all of this and a schema that did not would
     * refuse searches the database handles.
     */
    it.each(['hedge & trimmer', '!!!', '3" drill bit', 'Not A Slug'])(
      'accepts %j',
      async (keyword) => {
        await givenAListing(800);

        expect((await search({ keyword })).statusCode).toBe(200);
      },
    );

    it('refuses only a keyword past the length bound', async () => {
      await givenAListing(800);

      const response = await search({ keyword: 'x'.repeat(101) });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('characters or fewer');
    });

    /*
     * **A refused request is not a search**, which is slice 3.1f's rule holding
     * for the third kind of refusal now.
     */
    it('records nothing for a keyword it refused', async () => {
      await givenAListing(800);

      await search({ keyword: 'x'.repeat(101) });

      expect(listings.metrics.listingSearches).toEqual([]);
    });

    it('passes null down when no words were asked for', async () => {
      await givenAListing(800);

      await search();

      expect(listings.proximity.keywords).toEqual([null]);
    });

    /*
     * **Both filters at once, which is what Browse will send.** Each is proved
     * alone above; this is the one that would catch a service passing one down
     * and dropping the other, which returns a plausible page either way.
     */
    it('composes with the category filter', async () => {
      await givenACategory('power-tools', SCHEMA, TRANSPORT);

      const wanted = await givenAListing(800, {
        categorySlug: 'outdoor-gardening',
        text: 'petrol hedge trimmer',
      });
      await givenAListing(900, {
        categorySlug: 'power-tools',
        text: 'petrol hedge trimmer',
      });
      await givenAListing(1_000, {
        categorySlug: 'outdoor-gardening',
        text: 'lawn mower',
      });

      const results = parsePublicListingSearchResults(
        (await search({ category: 'outdoor-gardening', keyword: 'trimmer' })).json(),
      );

      expect(results.results.map((result) => result.id)).toEqual([wanted.id]);
      expect(results.category).toBe('outdoor-gardening');
      expect(results.keyword).toBe('trimmer');
    });
  });

  /**
   * Paging through results (slice 3.1d).
   *
   * **The properties worth asserting are the ones offset pagination gets wrong
   * quietly**: a row served twice, a row served never, or a second page that is
   * simply the first again. None of those produce an error, and all three look
   * plausible on screen.
   */
  describe('paging through the results', () => {
    /** One more than a page, so there is a second page with exactly one on it. */
    async function givenAPageAndOne() {
      const created = [];
      for (let index = 0; index <= SEARCH_RESULT_LIMIT; index += 1) {
        // Distinct distances, so the expected order is unambiguous and a
        // paging defect cannot hide behind a tie.
        created.push(await givenAListing(100 + index * 10));
      }
      return created;
    }

    it('serves the rest on the second page', async () => {
      const created = await givenAPageAndOne();

      const second = parsePublicListingSearchResults(
        (await search({ page: 2 })).json(),
      );

      expect(second.results.map((result) => result.id)).toEqual([
        created[SEARCH_RESULT_LIMIT]?.id,
      ]);
      expect(second.truncated).toBe(false);
      expect(second.page).toBe(2);
    });

    it('repeats nothing and skips nothing across the boundary', async () => {
      const created = await givenAPageAndOne();

      const first = parsePublicListingSearchResults((await search()).json());
      const second = parsePublicListingSearchResults(
        (await search({ page: 2 })).json(),
      );
      const seen = [...first.results, ...second.results].map((result) => result.id);

      // Every listing exactly once, in the order they were placed — which is
      // nearest first, because each was put ten metres further out.
      expect(seen).toEqual(created.map((listing) => listing.id));
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('says which page it answered, so a defaulted page is not misread', async () => {
      await givenAListing(800);

      const response = await app.inject({
        method: 'GET',
        url: '/public/listings?postcode=BS7%208AA',
      });

      expect(parsePublicListingSearchResults(response.json()).page).toBe(1);
    });

    it('is an empty page past the end rather than an error', async () => {
      // Reachable from a stale link. The page distinguishes it from "nothing
      // near you" and offers the way back instead of a wider radius.
      await givenAListing(800);

      const response = await search({ page: 3 });

      expect(response.statusCode).toBe(200);
      const results = parsePublicListingSearchResults(response.json());
      expect(results.results).toEqual([]);
      expect(results.page).toBe(3);
    });

    describe('what it refuses', () => {
      it('rejects page zero', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/public/listings?postcode=BS7%208AA&page=0',
        });

        expect(response.statusCode).toBe(400);
      });

      /*
       * **The availability control, fired.** Offset pagination skips rows the
       * database has already found, so an uncapped page number lets a caller
       * choose how much work we do — on the one public collection route with no
       * rate limiting in front of it (`SECURITY.md`). Refused rather than
       * clamped, for the reason a radius of 7 is refused.
       */
      it('rejects a page past the cap rather than serving a huge offset', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/public/listings?postcode=BS7%208AA&page=${String(MAX_SEARCH_PAGE + 1)}`,
        });

        expect(response.statusCode).toBe(400);
      });

      it('rejects a page that is not a whole number', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/public/listings?postcode=BS7%208AA&page=1.5',
        });

        expect(response.statusCode).toBe(400);
      });
    });
  });
});

/**
 * The categories a searcher may filter by (slice 3.2b).
 *
 * **Driven with no authorization header**, which is the whole point of the
 * route: `/categories` is behind `AuthGuard`, and Browse is the page a
 * signed-out stranger meets first. A filter that needed an account would be a
 * dead control wearing a login prompt.
 *
 * **A top-level describe rather than a child of the search one**, because it has
 * to be able to test a platform with *no* categories configured — and every
 * search block creates one in its own `beforeEach`.
 */
describe('the public category list', () => {
  function publicCategories() {
    return app.inject({ method: 'GET', url: '/public/categories' });
  }

  it('is an empty list rather than an error when nothing is configured', async () => {
    // The state of a fresh platform, and of local development right now. The
    // page renders without the control; it must not fail.
    const response = await publicCategories();

    expect(response.statusCode).toBe(200);
    expect(parsePublicCategories(response.json()).categories).toEqual([]);
  });

  it('answers a caller with no session at all', async () => {
    await givenACategory();

    const response = await publicCategories();

    expect(response.statusCode).toBe(200);
    expect(parsePublicCategories(response.json()).categories).toEqual([
      { slug: 'outdoor-gardening', name: 'Outdoor and gardening' },
    ]);
  });

  it('lists every category, oldest first', async () => {
    await givenACategory();
    await givenACategory('power-tools', SCHEMA, TRANSPORT);

    const { categories } = parsePublicCategories((await publicCategories()).json());

    expect(categories.map((category) => category.slug)).toEqual([
      'outdoor-gardening',
      'power-tools',
    ]);
  });

  /*
   * **A slug and a name, and nothing else on the wire.** The owner's
   * `/categories` carries the attribute schema, the transport options and the
   * version number; the admin one adds the risk level and the reportable
   * activity flag (ADR 0028). None of that belongs on a route anybody on the
   * internet can call, and the guarantee is the *shape* rather than a filter
   * somebody has to remember — asserted against the raw body, because that is
   * what actually crosses the wire.
   *
   * **It also rules out a count.** A listing count per category would publish
   * BRD §17's dominant risk — how thin our supply is — as an endpoint, live, to
   * anybody who asks. There is no field here it could arrive in.
   */
  it('discloses no configuration beyond a slug and a name', async () => {
    await givenACategory();

    const body = (await publicCategories()).json() as {
      categories: Record<string, unknown>[];
    };

    expect(Object.keys(body.categories[0] ?? {}).sort()).toEqual(['name', 'slug']);

    const raw = JSON.stringify(body);
    for (const absent of [
      'attributes',
      'transportOptions',
      'riskLevel',
      'reportableActivity',
      'feePolicy',
      'versionNumber',
      'count',
    ]) {
      expect(raw).not.toContain(absent);
    }
  });

  /*
   * **The name is the current version's**, which is what makes renaming safe:
   * the slug in every URL and every filter stays put, and only the label moves.
   */
  it('shows the current version’s name after a rename', async () => {
    await givenACategory();
    await reconfiguredName('Garden and outdoor');

    const { categories } = parsePublicCategories((await publicCategories()).json());

    expect(categories).toEqual([
      { slug: 'outdoor-gardening', name: 'Garden and outdoor' },
    ]);
  });
});
