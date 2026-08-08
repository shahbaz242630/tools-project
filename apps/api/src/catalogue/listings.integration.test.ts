import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CATEGORY_OPTIONS_PATH,
  LISTINGS_PATH,
  ME_PATH,
  listingPath,
  listingPublicationPath,
  parseCategoryOptions,
  parseOwnerListing,
} from '@platform/contracts';
import type { CategoryAttribute, CategoryTransportOption } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { FakeGeocoder } from '../search-location/testing/fakes.js';
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
      transportOptions: [],
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
    // and a reason nobody reads devalues the ones that matter. 2.11's concierge
    // creation is where an audited version belongs.
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
   * **The property the whole slice turns on** (§8.2, ADR 0029, ADR 0033).
   *
   * A listing priced under version 1 keeps version 1's rates when the category
   * is repriced. Reading against the current policy would silently re-price
   * every existing listing the moment an administrator changed a percentage —
   * and the owner would see a different number with nothing having happened to
   * their listing.
   */
  it('prices against the pinned version, not the category as it stands now', async () => {
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
    expect(created.inclusiveDailyPrice?.renterFee.amount).toBe(144);

    // The category doubles its renter fee, minting version 2. The listing still
    // points at version 1.
    const author = await idOf('alice-token');
    await listings.categories.addVersion(
      'outdoor-gardening',
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        transportOptions: [],
        feePolicy: { ...FEE_POLICY, renterFeeBasisPoints: 1_600 },
      },
      author,
    );

    const reread = parseOwnerListing(
      (
        await app.inject({
          method: 'GET',
          url: listingPath(created.id),
          headers: auth('alice-token'),
        })
      ).json(),
    );

    expect(reread.categoryVersionNumber).toBe(1);
    // Still 8%, not 16%. £1.44, not £2.88.
    expect(reread.inclusiveDailyPrice?.renterFee.amount).toBe(144);
    expect(reread.inclusiveDailyPrice?.total.amount).toBe(1_944);
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
