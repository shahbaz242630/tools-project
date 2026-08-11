import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  LISTINGS_PATH,
  ME_PATH,
  adminListingModerationPath,
  listingPath,
  listingPublicationPath,
  parseOwnerListing,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { createNoopMetrics } from '@platform/observability';
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
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { FakeGeocoder } from '../search-location/testing/fakes.js';

/**
 * Moderation through the real application (§8.3, §9, ADR 0041, slice 2.8c-i).
 *
 * **This file exists for the authorisation, not the state machine.** The service
 * decides what a decision means; only this level can prove who may make one —
 * and that matters more here than on any other listing route, because it is the
 * first write in Catalogue that is *not* protected by ownership. Every other
 * write puts the owner in the `where`, so a missing guard would still refuse a
 * stranger. Here a missing guard hands every listing on the platform to
 * anybody signed in.
 *
 * So the route is exercised by an administrator, by an administrator whose
 * second factor is stale, by an ordinary user, and by nobody at all.
 */

const CATEGORY = 'outdoor-gardening';

const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};

const ADMIN = {
  clerkUserId: 'user_admin',
  sessionId: 'sess_ad',
  email: 'admin@example.com',
  secondFactorAgeMinutes: 5,
};
/** An administrator whose second factor is too old to count (ADR 0021). */
const STALE_ADMIN = {
  clerkUserId: 'user_stale',
  sessionId: 'sess_st',
  email: 'stale@example.com',
  secondFactorAgeMinutes: 60 * 24,
};
const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
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
  // One audit fake across the module and the listings service, so an entry
  // written by moderation is one this test can actually see.
  listings = createListingFakes(categories, audit);
  listings.geocoder.knows(FakeGeocoder.BS7_8AA);

  identity.sessionVerifier
    .accept('admin-token', ADMIN)
    .accept('stale-token', STALE_ADMIN)
    .accept('alice-token', ALICE);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
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

  await categories.create(
    {
      slug: CATEGORY,
      name: 'Outdoor and gardening',
      riskLevel: 'low',
      reportableActivity: 'none',
      attributes: [],
      transportOptions: [],
      feePolicy: FEE_POLICY,
    },
    'seed',
  );
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

async function promoteAdmin(): Promise<void> {
  identity.users.promote(await idOf('admin-token'));
  identity.users.promote(await idOf('stale-token'));
}

/** A listing belonging to Alice, published so hiding it means something. */
async function givenAPublishedListing(): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: LISTINGS_PATH,
    headers: auth('alice-token'),
    payload: {
      categorySlug: CATEGORY,
      title: 'Petrol hedge trimmer',
      description: 'Serviced last spring.',
      replacementValue: { amount: 24_999, currency: 'GBP' },
      categoryVersionNumber: 1,
      attributes: {},
      transportRequirement: null,
      requiresTwoPersonLift: false,
      rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
      collectionLocation: {
        line1: '14 Gloucester Road',
        line2: null,
        town: 'Bristol',
        postcode: 'BS7 8AA',
      },
    },
  });

  const listing = parseOwnerListing(created.json());
  await app.inject({
    method: 'POST',
    url: listingPublicationPath(listing.id),
    headers: auth('alice-token'),
  });
  return listing.id;
}

const moderate = (id: string, body: Record<string, unknown>, token = 'admin-token') =>
  app.inject({
    method: 'PUT',
    url: adminListingModerationPath(id),
    headers: auth(token),
    payload: body,
  });

describe('who may moderate a listing', () => {
  it('refuses an anonymous caller', async () => {
    await promoteAdmin();
    const id = await givenAPublishedListing();

    const response = await app.inject({
      method: 'PUT',
      url: adminListingModerationPath(id),
      payload: { state: 'REJECTED', reason: 'Prohibited item' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an ordinary signed-in user — including the listing’s own owner', async () => {
    await promoteAdmin();
    const id = await givenAPublishedListing();

    // The owner is the interesting half. Everywhere else in this module being
    // the owner is what grants access; here it grants nothing, because
    // moderation is not something you do to your own listing.
    const response = await moderate(id, { state: 'APPROVED' }, 'alice-token');

    expect(response.statusCode).toBe(403);
  });

  it('refuses an administrator whose second factor is stale (ADR 0021)', async () => {
    await promoteAdmin();
    const id = await givenAPublishedListing();

    const response = await moderate(
      id,
      { state: 'REJECTED', reason: 'Prohibited item' },
      'stale-token',
    );

    expect(response.statusCode).toBe(403);
  });

  it('leaves the listing untouched when it refuses', async () => {
    await promoteAdmin();
    const id = await givenAPublishedListing();

    await moderate(id, { state: 'REJECTED', reason: 'Prohibited item' }, 'alice-token');

    // A refusal that had already written would be the worst of both.
    const [stored] = listings.listings.all();
    expect(stored?.moderationState).toBe('APPROVED');
  });
});

describe('moderating a listing', () => {
  beforeEach(promoteAdmin);

  it('hides it, without touching what the owner wanted', async () => {
    const id = await givenAPublishedListing();

    const response = await moderate(id, {
      state: 'REJECTED',
      reason: 'The photographs show a different item',
    });

    expect(response.statusCode).toBe(200);

    const [stored] = listings.listings.all();
    expect(stored?.moderationState).toBe('REJECTED');
    // **The owner's intent survives**, which is the whole of ADR 0041. With one
    // field this would now read DRAFT or PAUSED and reinstatement would guess.
    expect(stored?.status).toBe('PUBLISHED');
  });

  it('writes an audit entry naming the listing and carrying the reason', async () => {
    const id = await givenAPublishedListing();

    await moderate(id, { state: 'REJECTED', reason: 'Prohibited item' });

    const entry = audit.log.entries().at(-1);
    expect(entry?.action).toBe('listing.moderated');
    expect(entry?.targetType).toBe('listing');
    expect(entry?.targetId).toBe(id);
    expect(entry?.reason).toBe('Prohibited item');
    // Digests either side, never values (ADR 0017) — and they differ, which is
    // what proves the entry describes a change rather than restating a row.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('records the administrator, not the owner', async () => {
    const id = await givenAPublishedListing();
    const adminId = await idOf('admin-token');

    await moderate(id, { state: 'UNDER_REVIEW', reason: 'Checking the serial number' });

    expect(audit.log.entries().at(-1)?.actorId).toBe(adminId);
  });

  it('puts a listing back, and clears the reason with it', async () => {
    const id = await givenAPublishedListing();
    await moderate(id, { state: 'REJECTED', reason: 'Prohibited item' });

    const response = await moderate(id, { state: 'APPROVED' });

    expect(response.statusCode).toBe(200);
    const [stored] = listings.listings.all();
    expect(stored?.moderationState).toBe('APPROVED');
    // A stale reason is worse than none: 2.8c-ii shows it to the owner.
    expect(stored?.moderationReason).toBeNull();
  });

  it('refuses to hide a listing with no reason', async () => {
    const id = await givenAPublishedListing();

    const response = await moderate(id, { state: 'REJECTED' });

    // 400, not 422: the body is missing a field and supplying it fixes the
    // request. 422 means "the request is fine and the listing's state is not".
    expect(response.statusCode).toBe(400);
    expect(listings.listings.all()[0]?.moderationState).toBe('APPROVED');
  });

  it('treats a blank reason as no reason at all', async () => {
    const id = await givenAPublishedListing();

    expect((await moderate(id, { state: 'REJECTED', reason: '   ' })).statusCode).toBe(
      400,
    );
  });

  it('refuses a reason below the floor every other administrative reason clears', async () => {
    const id = await givenAPublishedListing();

    // `MIN_ADMIN_REASON_LENGTH`, which this route did not honour when it was
    // first written: `"no"` was accepted, while suspension, role changes,
    // account lookups and feature flags all required twelve characters. The
    // owner reads this one (2.8c-ii), so it holds to the same bar.
    const response = await moderate(id, { state: 'REJECTED', reason: 'no' });

    expect(response.statusCode).toBe(400);
    expect(listings.listings.all()[0]?.moderationState).toBe('APPROVED');
  });

  it('answers 404 for a listing that does not exist', async () => {
    const response = await moderate('11111111-1111-4111-8111-111111111111', {
      state: 'REJECTED',
      reason: 'Prohibited item',
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a state outside the vocabulary', async () => {
    const id = await givenAPublishedListing();

    expect((await moderate(id, { state: 'BANNED', reason: 'x' })).statusCode).toBe(400);
  });

  it('does not hand the moderator the owner’s address', async () => {
    const id = await givenAPublishedListing();

    const response = await moderate(id, {
      state: 'REJECTED',
      reason: 'Prohibited item',
    });

    // §8.4.1: the precise address is disclosed only after a booking reaches a
    // state that permits it, and a moderation decision is not that state. The
    // route answers with the decision alone rather than echoing the record.
    const body = JSON.stringify(response.json());
    expect(body).not.toContain('Gloucester Road');
    expect(body).not.toContain('BS7 8AA');
  });

  it('writes no audit entry when it refuses for a missing reason', async () => {
    const id = await givenAPublishedListing();
    const before = audit.log.entries().length;

    await moderate(id, { state: 'REJECTED' });

    // The refusal happens before the read and before the write, so there is
    // nothing to record — and an entry for a decision that never took effect
    // would be worse than none.
    expect(audit.log.entries()).toHaveLength(before);
  });
});

describe('what an owner sees of a moderated listing', () => {
  beforeEach(promoteAdmin);

  it('still lets them read it', async () => {
    const id = await givenAPublishedListing();
    await moderate(id, { state: 'REJECTED', reason: 'Prohibited item' });

    const response = await app.inject({
      method: 'GET',
      url: listingPath(id),
      headers: auth('alice-token'),
    });

    // Hiding it from the public must not hide it from its owner: they are the
    // one person who has to be able to see what happened to it.
    expect(response.statusCode).toBe(200);
  });

  it('carries the decision and the reason into the owner’s own projection', async () => {
    /*
     * Slice 2.8c-ii, and the gap it closed. 2.8c-i added the state, the column,
     * the constraint and the route, and stopped at what an *administrator* could
     * do — `toOwnerListing` was never touched, so the platform could hide a
     * listing while the only page its owner can open went on calling it published.
     *
     * Asserted against the **raw body** rather than the parsed object, for the
     * reason `profiles.integration.test.ts` gives about leaks: parsing first would
     * let a schema that has drifted silently supply or strip a field, and this
     * test is precisely about whether the wire carries it.
     */
    const id = await givenAPublishedListing();
    await moderate(id, {
      state: 'REJECTED',
      reason: 'Prohibited item, reported twice',
    });

    const response = await app.inject({
      method: 'GET',
      url: listingPath(id),
      headers: auth('alice-token'),
    });

    const body = response.json() as Record<string, unknown>;
    expect(body.moderationState).toBe('REJECTED');
    expect(body.moderationReason).toBe('Prohibited item, reported twice');

    // What the owner set is untouched and still says so, which is the whole point
    // of ADR 0041 and the thing the page has to be able to tell them apart.
    expect(body.status).toBe('PUBLISHED');
  });

  it('tells the owner nothing is holding back a listing nobody has moderated', async () => {
    // The default has to be distinguishable from a decision, on the wire as well
    // as in the database: `APPROVED` with a null reason is "nobody has objected",
    // not "somebody approved this".
    const id = await givenAPublishedListing();

    const response = await app.inject({
      method: 'GET',
      url: listingPath(id),
      headers: auth('alice-token'),
    });

    const body = response.json() as Record<string, unknown>;
    expect(body.moderationState).toBe('APPROVED');
    expect(body.moderationReason).toBeNull();
  });

  it('does not tell the owner who moderated their listing', async () => {
    // The reason is owed to them; the moderator's identity is not — the same line
    // drawn for a suspended account, where the subject reads the reason and never
    // the administrator behind it.
    const id = await givenAPublishedListing();
    await moderate(id, { state: 'UNDER_REVIEW', reason: 'Checking the safety guard' });

    const response = await app.inject({
      method: 'GET',
      url: listingPath(id),
      headers: auth('alice-token'),
    });

    const raw = JSON.stringify(response.json());
    expect(raw).not.toContain('moderatedBy');
    expect(raw).not.toContain('moderatedAt');
  });
});
