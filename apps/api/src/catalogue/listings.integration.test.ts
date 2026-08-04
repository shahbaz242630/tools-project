import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CATEGORY_OPTIONS_PATH,
  LISTINGS_PATH,
  ME_PATH,
  listingPath,
  parseCategoryOptions,
  parseOwnerListing,
} from '@platform/contracts';
import type { CategoryAttribute } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from './catalogue.service.js';
import { InMemoryCategoryStore, createListingFakes } from './testing/fakes.js';
import type { ListingFakes } from './testing/fakes.js';

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
};

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
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(categories, audit.service),
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
): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.create(
    {
      slug,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes,
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
