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

const DRAFT = {
  categorySlug: 'outdoor-gardening',
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
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
async function givenACategory(slug = 'outdoor-gardening'): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.create(
    {
      slug,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: [],
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
      { slug: 'outdoor-gardening', name: 'Outdoor and gardening' },
    ]);
  });

  it('discloses no administrative configuration', async () => {
    // Not `AdminCategory`. The risk level, the reportable-activity flag and the
    // attribute schema are configuration an owner picking from a dropdown has
    // no business receiving — and the parse above would strip them silently, so
    // this asserts against the raw body instead.
    await givenACategory();

    const response = await app.inject({
      method: 'GET',
      url: CATEGORY_OPTIONS_PATH,
      headers: auth('alice-token'),
    });

    const raw = response.json() as { categories: readonly Record<string, unknown>[] };
    expect(Object.keys(raw.categories[0] ?? {}).sort()).toEqual(['name', 'slug']);
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
