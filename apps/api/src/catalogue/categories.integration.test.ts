import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ADMIN_CATEGORIES_ROUTE,
  ME_PATH,
  adminCategoryPath,
  parseAdminCategory,
  parseAdminCategoryList,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import { CATEGORY_LIST_LIMIT } from './limits.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { CatalogueService } from './catalogue.service.js';
import { InMemoryCategoryStore, createListingFakes } from './testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { bookingModuleFakes } from '../booking/testing/fakes.js';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  DEFAULT_REQUEST_EXPIRY_HOURS,
} from '@platform/contracts';

/** A priced category (BRD §8.2, §3.4, slice 2.7a). */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
  minimumPlatformFee: { amount: 100, currency: 'GBP' },
};
/**
 * A real band rather than `null`, for `FEE_POLICY`'s reason applied to §8.7.2:
 * `null` is what a category carries when nobody has configured damage security,
 * so a suite where every fixture is null would never notice a path that silently
 * dropped the band. Tests that mean "no security" say so locally.
 */
const DAMAGE_SECURITY = {
  excessFloor: { amount: 7_500, currency: 'GBP' },
  excessPercentageBasisPoints: 1_500,
  recoveryCeiling: { amount: 50_000, currency: 'GBP' },
} as const;

/**
 * Categories through the real application: real routing, real guard, real
 * exception filter.
 *
 * What only this level can prove is authorisation. The service tests know
 * nothing about roles or second factors — the guard is what enforces both, and
 * a rule enforced by a decorator is one that can be lost by deleting the
 * decorator. So every route is exercised twice: once by an administrator, once
 * by somebody who must not reach it.
 *
 * The store is the in-memory double rather than Prisma. This test is about who
 * may call these routes, not about what Postgres does with the rows;
 * `prisma-category-store.db.test.ts` covers that against a real database.
 */

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
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

const REASON = 'opening the launch category for the pilot';
const DRAFT = {
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  riskLevel: 'low',
  reportableActivity: 'none',
  reportingDutiesAcknowledged: false,
  attributes: [],
  feePolicy: FEE_POLICY,
  damageSecurity: DAMAGE_SECURITY,
  maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
  requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
  transportOptions: [],
} as const;

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let store: InMemoryCategoryStore;

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  store = new InMemoryCategoryStore();

  identity.sessionVerifier
    .accept('admin-token', ADMIN)
    .accept('stale-token', STALE_ADMIN)
    .accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter: allowAllRateLimiter,
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
          store,
          audit.service,
          createRecordingLogger().logger,
        ),
        featureFlags: createFeatureFlagFakes().service,
        // Sharing `store` so both surfaces talk about the same categories — a
        // category created through the admin routes here is one an owner could
        // then list in.
        listings: createListingFakes(store, audit).service,
        ...bookingModuleFakes(),
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

const createPath = `${ADMIN_CATEGORIES_ROUTE}?reason=${encodeURIComponent(REASON)}`;

async function createCategory(
  token = 'admin-token',
  body: Record<string, unknown> = { ...DRAFT },
) {
  return app.inject({
    method: 'POST',
    url: createPath,
    headers: auth(token),
    payload: body,
  });
}

/**
 * The mirror row is created just-in-time on first authenticated request, so the
 * id only exists once the token has been used once — the same reason every
 * other admin integration test promotes through `/me` rather than by fiat.
 */
async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

/** Promote the administrators, so the guard's role check can pass at all. */
async function promoteAdmin(): Promise<void> {
  identity.users.promote(await idOf('admin-token'));
  identity.users.promote(await idOf('stale-token'));
}

describe('authorisation', () => {
  it('refuses an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: ADMIN_CATEGORIES_ROUTE });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an ordinary signed-in user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_ROUTE,
      headers: auth('bob-token'),
    });
    // 403, not 404: the route exists and they are simply not allowed to use it.
    expect(response.statusCode).toBe(403);
  });

  it('refuses an ordinary user trying to create one', async () => {
    const response = await createCategory('bob-token');
    expect(response.statusCode).toBe(403);
    expect(await store.list(CATEGORY_LIST_LIMIT)).toHaveLength(0);
  });

  it('refuses an administrator whose second factor is stale', async () => {
    await promoteAdmin();

    // ADR 0021: the role is not enough. A token carrying no recent `fva` proof
    // is refused, and this is the test that would fail if the guard stopped
    // asking — the role check alone would pass here.
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_ROUTE,
      headers: auth('stale-token'),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('creating a category', () => {
  beforeEach(promoteAdmin);

  it('creates it and answers the contract', async () => {
    const response = await createCategory();

    expect(response.statusCode).toBe(201);
    const created = parseAdminCategory(response.json());
    expect(created.slug).toBe('outdoor-gardening');
    expect(created.versionNumber).toBe(1);
  });

  it('rejects a slug that is not URL-safe, naming the field', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      slug: 'Outdoor Gardening!',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/slug/i);
  });

  it('rejects an unknown risk level', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      riskLevel: 'catastrophic',
    });
    expect(response.statusCode).toBe(400);
  });

  it('demands a reason', async () => {
    // §8.13 requires actor, reason, target and before/after on every admin
    // action. Without the query parameter there is nothing to record.
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_CATEGORIES_ROUTE,
      headers: auth('admin-token'),
      payload: { ...DRAFT },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a reason too short to mean anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${ADMIN_CATEGORIES_ROUTE}?reason=${encodeURIComponent('why')}`,
      headers: auth('admin-token'),
      payload: { ...DRAFT },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reads a reason the web app encoded, spaces and all', async () => {
    // The two sides have to agree about query encoding, and they do not use the
    // same function. `URLSearchParams` — which is what `admin-categories.ts`
    // builds the URL with — writes a space as `+`, where `encodeURIComponent`
    // writes `%20`. If the API decoded `+` literally, every recorded reason
    // would read "opening+the+launch+category" and nothing would fail loudly.
    const url = new URL('http://localhost/admin/categories');
    url.searchParams.set('reason', REASON);

    const response = await app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      headers: auth('admin-token'),
      payload: { ...DRAFT, slug: 'encoded-reason' },
    });

    expect(response.statusCode).toBe(201);
    const entry = audit.log.entries().at(-1);
    expect(entry?.reason).toBe(REASON);
  });

  it('answers 409 when the slug is taken, not 400', async () => {
    await createCategory();
    const again = await createCategory('admin-token', { ...DRAFT, name: 'Different' });

    // The body is well formed; the world refuses it. Telling an administrator
    // to correct a field that is already correct is the failure this avoids.
    expect(again.statusCode).toBe(409);
  });
});

describe('reconfiguring a category', () => {
  beforeEach(async () => {
    await promoteAdmin();
    await createCategory();
  });

  const configurePath = (slug: string, reason: string) =>
    `${adminCategoryPath(slug)}?reason=${encodeURIComponent(reason)}`;

  it('mints a new version and leaves the old one alone', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'renamed after the taxonomy review'),
      headers: auth('admin-token'),
      payload: {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseAdminCategory(response.json()).versionNumber).toBe(2);

    const versions = store.versionsOf('outdoor-gardening');
    expect(versions).toHaveLength(2);
    expect(versions[0]?.name).toBe('Outdoor and gardening');
  });

  it('answers 404 for a category that does not exist', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: configurePath('no-such-category', 'should not be possible'),
      headers: auth('admin-token'),
      payload: {
        name: 'Nothing',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an ordinary user', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'should not be possible'),
      headers: auth('bob-token'),
      payload: {
        name: 'Hijacked',
        riskLevel: 'high',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(store.versionsOf('outdoor-gardening')).toHaveLength(1);
  });

  it('has no way to change the slug', async () => {
    // The contract has no such field, so an attempt is ignored rather than
    // honoured. Asserted because a slug that can move breaks every indexed URL
    // pointing at the category, and nothing else here would notice.
    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'attempting to move the slug'),
      headers: auth('admin-token'),
      payload: {
        name: 'Renamed',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
        slug: 'something-else',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseAdminCategory(response.json()).slug).toBe('outdoor-gardening');
    expect(await store.findBySlug('something-else')).toBeNull();
  });
});

describe('reading categories', () => {
  beforeEach(async () => {
    await promoteAdmin();
    await createCategory();
  });

  it('lists them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_ROUTE,
      headers: auth('admin-token'),
    });

    expect(response.statusCode).toBe(200);
    const { categories } = parseAdminCategoryList(response.json());
    expect(categories.map((category) => category.slug)).toEqual(['outdoor-gardening']);
  });

  it('reads one by slug', async () => {
    const response = await app.inject({
      method: 'GET',
      url: adminCategoryPath('outdoor-gardening'),
      headers: auth('admin-token'),
    });

    expect(response.statusCode).toBe(200);
    expect(parseAdminCategory(response.json()).name).toBe('Outdoor and gardening');
  });

  it('answers 404 for an unknown slug', async () => {
    const response = await app.inject({
      method: 'GET',
      url: adminCategoryPath('no-such-category'),
      headers: auth('admin-token'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('needs no reason, unlike reading a person', async () => {
    // Deliberately different from the admin surface in `identity/`. A category
    // has no subject to owe an explanation to, and a reason nobody reads is a
    // ritual that devalues the ones that matter.
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_ROUTE,
      headers: auth('admin-token'),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('the attribute schema, through the routes', () => {
  const SCHEMA = [
    {
      key: 'power_source',
      label: 'Power source',
      required: true,
      type: 'choice',
      options: [
        { value: 'petrol', label: 'Petrol' },
        { value: 'cordless', label: 'Cordless' },
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
  ];

  beforeEach(async () => {
    await promoteAdmin();
  });

  it('accepts a schema on create and returns it', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      attributes: SCHEMA,
    });

    expect(response.statusCode).toBe(201);
    expect(parseAdminCategory(response.json()).attributes).toEqual(SCHEMA);
  });

  it('reads the schema back on a later request', async () => {
    await createCategory('admin-token', { ...DRAFT, attributes: SCHEMA });

    const response = await app.inject({
      method: 'GET',
      url: adminCategoryPath('outdoor-gardening'),
      headers: auth('admin-token'),
    });

    expect(parseAdminCategory(response.json()).attributes).toEqual(SCHEMA);
  });

  it('replaces the schema rather than merging it', async () => {
    // `PUT` carries the whole configuration for the reason slice 2.1 chose it:
    // a partial update would merge against whatever version happens to be
    // current when the request lands, producing a schema neither administrator
    // wrote.
    await createCategory('admin-token', { ...DRAFT, attributes: SCHEMA });

    const response = await app.inject({
      method: 'PUT',
      url: `${adminCategoryPath('outdoor-gardening')}?reason=${encodeURIComponent(
        'dropping the weight attribute',
      )}`,
      headers: auth('admin-token'),
      payload: {
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [SCHEMA[0]],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseAdminCategory(response.json()).attributes).toHaveLength(1);
    // Version 1 still has both. A listing filled in under it is still readable.
    expect(store.versionsOf('outdoor-gardening')[0]?.attributes).toHaveLength(2);
  });

  it('rejects a missing schema rather than defaulting it to empty', async () => {
    // ADR 0025's lesson: an optional field is a silent default, and this silent
    // default would clear the schema every listing in the category is filled in
    // against — while answering 200.
    const response = await createCategory('admin-token', {
      slug: DRAFT.slug,
      name: DRAFT.name,
      riskLevel: DRAFT.riskLevel,
      reportableActivity: DRAFT.reportableActivity,
      reportingDutiesAcknowledged: DRAFT.reportingDutiesAcknowledged,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a type outside the vocabulary, naming the field', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      attributes: [
        { key: 'available_from', label: 'From', required: false, type: 'date' },
      ],
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/attributes|type/i);
  });

  it('rejects two attributes sharing a key', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      attributes: [SCHEMA[0], { ...SCHEMA[0], label: 'Fuel' }],
    });

    expect(response.statusCode).toBe(400);
  });

  it('writes nothing when the schema is refused', async () => {
    await createCategory('admin-token', {
      ...DRAFT,
      slug: 'bad-schema',
      attributes: [{ key: 'x', label: 'X', required: false, type: 'text' }],
    });

    // `maxLength` is missing, so the whole request fails — and a rejected
    // request must not leave a category behind, or a retry hits 409 on a
    // category nobody successfully created.
    expect(await store.findBySlug('bad-schema')).toBeNull();
  });
});

/**
 * The reportable-activity flag, through the routes (§8.14.2).
 *
 * These are the tests that matter most in this file, because the thing being
 * guarded is not a data-quality rule — it is the platform's regulatory status.
 * Everything else here can be got wrong and fixed; this can be got wrong and
 * discovered by HMRC.
 */
describe('the reportable-activity flag', () => {
  beforeEach(async () => {
    await promoteAdmin();
  });

  const configurePath = (slug: string, reason: string) =>
    `${adminCategoryPath(slug)}?reason=${encodeURIComponent(reason)}`;

  it('stores and returns none for an ordinary goods category', async () => {
    const response = await createCategory();

    expect(response.statusCode).toBe(201);
    expect(parseAdminCategory(response.json()).reportableActivity).toBe('none');
  });

  it('refuses a reportable category that was not acknowledged', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      slug: 'trailers-towing',
      reportableActivity: 'means_of_transport',
      reportingDutiesAcknowledged: false,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    expect(body.issues?.join(' ')).toMatch(/counsel/i);
  });

  it('creates nothing when the acknowledgement is missing', async () => {
    await createCategory('admin-token', {
      ...DRAFT,
      slug: 'trailers-towing',
      reportableActivity: 'means_of_transport',
      reportingDutiesAcknowledged: false,
    });

    // The refusal must be complete. A category that exists but was never
    // acknowledged is one whose reporting obligation nobody accepted.
    expect(await store.findBySlug('trailers-towing')).toBeNull();
  });

  it('accepts a reportable category once it is acknowledged', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      slug: 'trailers-towing',
      name: 'Trailers and towing',
      reportableActivity: 'means_of_transport',
      reportingDutiesAcknowledged: true,
    });

    expect(response.statusCode).toBe(201);
    expect(parseAdminCategory(response.json()).reportableActivity).toBe(
      'means_of_transport',
    );
  });

  it('refuses an unacknowledged switch on an existing category', async () => {
    // The case §17's risk register actually names: not a new category, but a
    // `none` one quietly becoming reportable. §8.14.2 words the warning as
    // being "on category creation"; obeying only the letter would leave this
    // route open.
    await createCategory();

    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'adding trailers to this category'),
      headers: auth('admin-token'),
      payload: {
        name: DRAFT.name,
        riskLevel: DRAFT.riskLevel,
        reportableActivity: 'means_of_transport',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    expect(response.statusCode).toBe(400);
    // And the version it would have written does not exist.
    expect(store.versionsOf('outdoor-gardening')).toHaveLength(1);
  });

  it('allows the switch when it is acknowledged, and keeps the old version', async () => {
    await createCategory();

    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'counsel confirmed the scope on 4 Aug'),
      headers: auth('admin-token'),
      payload: {
        name: DRAFT.name,
        riskLevel: DRAFT.riskLevel,
        reportableActivity: 'means_of_transport',
        reportingDutiesAcknowledged: true,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const versions = store.versionsOf('outdoor-gardening');
    expect(versions).toHaveLength(2);
    // The whole reason the flag lives on the version: a booking made yesterday
    // was made under a category that was not reportable, and it must stay that
    // way no matter what the category becomes today.
    expect(versions[0]?.reportableActivity).toBe('none');
    expect(versions[1]?.reportableActivity).toBe('means_of_transport');
  });

  it('rejects a head outside the vocabulary', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      reportableActivity: 'immovable_property',
      reportingDutiesAcknowledged: true,
    });

    expect(response.statusCode).toBe(400);
  });

  it('demands the flag rather than assuming none', async () => {
    const withoutFlag = Object.fromEntries(
      Object.entries(DRAFT).filter(([key]) => key !== 'reportableActivity'),
    );

    const response = await createCategory('admin-token', withoutFlag);

    // A default would mean the decision that changes our regulatory status
    // could be made by omission.
    expect(response.statusCode).toBe(400);
  });

  it('records the change of scope on both sides of the audit entry', async () => {
    await createCategory();
    await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'counsel confirmed the scope on 4 Aug'),
      headers: auth('admin-token'),
      payload: {
        name: DRAFT.name,
        riskLevel: DRAFT.riskLevel,
        reportableActivity: 'means_of_transport',
        reportingDutiesAcknowledged: true,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    const entries = audit.log.entries();
    const entry = entries.at(-1);
    expect(entry?.action).toBe('category.reconfigured');
    expect(entry?.reason).toBe('counsel confirmed the scope on 4 Aug');
    // Nothing else about the configuration changed, so if the flag were left
    // out of the digest these two would match and the one change that carries
    // statutory weight would leave no trace.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('does not store the acknowledgement itself', async () => {
    await createCategory('admin-token', {
      ...DRAFT,
      slug: 'trailers-towing',
      reportableActivity: 'means_of_transport',
      reportingDutiesAcknowledged: true,
    });

    // It is an assertion about a request, not a property of a category. Every
    // stored version with a reportable head was acknowledged by construction,
    // so a field carrying it would record a constant — and would eventually be
    // read as evidence of something it never proved.
    const stored = store.versionsOf('trailers-towing')[0];
    expect(stored).not.toHaveProperty('reportingDutiesAcknowledged');
  });
});

describe('the transport options', () => {
  beforeEach(async () => {
    await promoteAdmin();
  });

  const configurePath = (slug: string, reason: string) =>
    `${adminCategoryPath(slug)}?reason=${encodeURIComponent(reason)}`;

  const TRANSPORT = [
    { requirement: 'car_boot', suggestedUpToKg: 25 },
    { requirement: 'van_required', suggestedUpToKg: 150 },
  ];

  it('accepts a selection on create and returns it', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      feePolicy: FEE_POLICY,
      damageSecurity: DAMAGE_SECURITY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
      transportOptions: TRANSPORT,
    });

    expect(response.statusCode).toBe(201);
    expect(parseAdminCategory(response.json()).transportOptions).toEqual(TRANSPORT);
  });

  it('stores the selection in display order however it arrived', async () => {
    // The normalisation the contract does, proved at the boundary that actually
    // writes. Two administrators ticking the same boxes in a different order
    // must produce the same stored value, or the audit digest reports a change
    // nobody made (ADR 0017).
    const response = await createCategory('admin-token', {
      ...DRAFT,
      feePolicy: FEE_POLICY,
      damageSecurity: DAMAGE_SECURITY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
      transportOptions: [
        { requirement: 'trailer_required' },
        { requirement: 'hand_carryable' },
        { requirement: 'van_required' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(
      parseAdminCategory(response.json()).transportOptions.map(
        (option) => option.requirement,
      ),
    ).toEqual(['hand_carryable', 'van_required', 'trailer_required']);
  });

  it('demands the selection rather than assuming none', async () => {
    // ADR 0025's rule at the route. A caller that forgets must get a 400, not a
    // category that silently asks nothing about how its items are collected.
    const withoutOptions = Object.fromEntries(
      Object.entries(DRAFT).filter(([key]) => key !== 'transportOptions'),
    );

    expect((await createCategory('admin-token', withoutOptions)).statusCode).toBe(400);
  });

  it('rejects a requirement outside the vocabulary', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      transportOptions: [{ requirement: 'roof_rack' }],
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects the same requirement offered twice', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      transportOptions: [{ requirement: 'car_boot' }, { requirement: 'car_boot' }],
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects thresholds that do not increase, and says which two disagree', async () => {
    const response = await createCategory('admin-token', {
      ...DRAFT,
      feePolicy: FEE_POLICY,
      damageSecurity: DAMAGE_SECURITY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
      transportOptions: [
        { requirement: 'car_boot', suggestedUpToKg: 50 },
        { requirement: 'van_required', suggestedUpToKg: 20 },
      ],
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { issues?: readonly string[] };
    // Named by label, because the stored value appears nowhere on the form —
    // the mistake 2.4b made with `weight_kg` and fixed.
    expect(body.issues?.join(' ')).toContain('Van or large vehicle');
  });

  it('writes nothing when the selection is refused', async () => {
    await createCategory('admin-token', {
      ...DRAFT,
      slug: 'bad-transport',
      transportOptions: [{ requirement: 'roof_rack' }],
    });

    // A rejected request must not leave a category behind, or a retry hits 409
    // on one nobody successfully created.
    expect(await store.findBySlug('bad-transport')).toBeNull();
  });

  it('replaces the whole selection on a reconfiguration', async () => {
    await createCategory('admin-token', { ...DRAFT, transportOptions: TRANSPORT });

    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'these items all fit in a car'),
      headers: auth('admin-token'),
      payload: {
        name: DRAFT.name,
        riskLevel: DRAFT.riskLevel,
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [{ requirement: 'car_boot', suggestedUpToKg: 25 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseAdminCategory(response.json()).transportOptions).toHaveLength(1);
    // Version 1 still offers both. A listing that named the van under it is
    // still readable, which is why this lives on the version.
    expect(store.versionsOf('outdoor-gardening')[0]?.transportOptions).toHaveLength(2);
  });

  it('refuses an ordinary user', async () => {
    const response = await createCategory('bob-token', {
      ...DRAFT,
      feePolicy: FEE_POLICY,
      damageSecurity: DAMAGE_SECURITY,
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
      transportOptions: TRANSPORT,
    });

    expect(response.statusCode).toBe(403);
  });
});

/**
 * BRD §8.7.2's excess band through the real HTTP stack (slice 5.5a, ADR 0052).
 *
 * The band's arithmetic is `damage-excess.test.ts`, its rules are
 * `pricing.test.ts`, and the CHECKs are the db test. What only this file proves
 * is that the route carries the field at all — in both directions, on both
 * verbs, and that a caller who says nothing is refused rather than defaulted.
 */
describe('the damage security band over HTTP', () => {
  beforeEach(async () => {
    await promoteAdmin();
  });

  it('round-trips a configured band on create', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${ADMIN_CATEGORIES_ROUTE}?reason=${encodeURIComponent(REASON)}`,
      headers: auth('admin-token'),
      payload: DRAFT,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().damageSecurity).toEqual(DAMAGE_SECURITY);
  });

  it('accepts an explicit null — a category may require no security', () => {
    // §8.7.2: "unless the category is configured to require no security".
    return app
      .inject({
        method: 'POST',
        url: `${ADMIN_CATEGORIES_ROUTE}?reason=${encodeURIComponent(REASON)}`,
        headers: auth('admin-token'),
        payload: { ...DRAFT, damageSecurity: null },
      })
      .then((response) => {
        expect(response.statusCode).toBe(201);
        expect(response.json().damageSecurity).toBeNull();
      });
  });

  /**
   * The decision the whole slice rests on. An omitted field must be a 400 and
   * not a silent "no security", because the silent version configures exactly
   * what §8.7.2 prohibits doing silently — an item handed over with nothing held.
   */
  it('refuses a create that says nothing about damage security', async () => {
    // The same `Object.fromEntries` idiom the reportable-activity test uses:
    // a body with the field genuinely absent, which is what a caller that forgot
    // sends and what an optional field would silently accept.
    const withoutBand = Object.fromEntries(
      Object.entries(DRAFT).filter(([key]) => key !== 'damageSecurity'),
    );

    const response = await createCategory('admin-token', withoutBand);

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('damageSecurity');
  });

  it('refuses a reconfiguration that says nothing about damage security', async () => {
    await createCategory();
    const withoutBand = Object.fromEntries(
      Object.entries(DRAFT).filter(
        ([key]) => key !== 'damageSecurity' && key !== 'slug',
      ),
    );

    const response = await app.inject({
      method: 'PUT',
      url: `${adminCategoryPath('outdoor-gardening')}?reason=${encodeURIComponent(REASON)}`,
      headers: auth('admin-token'),
      payload: withoutBand,
    });

    expect(response.statusCode).toBe(400);
  });

  it('lets a reconfiguration remove the band deliberately', async () => {
    await createCategory();

    const response = await app.inject({
      method: 'PUT',
      url: `${adminCategoryPath('outdoor-gardening')}?reason=${encodeURIComponent(
        'items here are low value; no hold is worth taking',
      )}`,
      headers: auth('admin-token'),
      payload: {
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: null,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().damageSecurity).toBeNull();
  });

  it('refuses a floor above the recovery ceiling with a sentence, not a 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${ADMIN_CATEGORIES_ROUTE}?reason=${encodeURIComponent(REASON)}`,
      headers: auth('admin-token'),
      payload: {
        ...DRAFT,
        damageSecurity: {
          ...DAMAGE_SECURITY,
          excessFloor: { amount: 60_000, currency: 'GBP' },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain(
      'always bear more than could ever be recovered',
    );
  });

  it('carries the band on the list read as well as the write', async () => {
    await createCategory();

    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_ROUTE,
      headers: auth('admin-token'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().categories[0].damageSecurity).toEqual(DAMAGE_SECURITY);
  });

  /**
   * §8.13 makes administrative actions auditable, and this is the change with
   * somebody's money on the other side of it — removing a band means items go
   * out with nothing held. A version with no band looks exactly like a category
   * that never had one, so the digest is what separates them.
   */
  it('records the band in the audit digest, so removing one leaves a trace', async () => {
    await createCategory();
    const before = audit.log.entries().at(-1);

    await app.inject({
      method: 'PUT',
      url: `${adminCategoryPath('outdoor-gardening')}?reason=${encodeURIComponent(
        'items here are low value; no hold is worth taking',
      )}`,
      headers: auth('admin-token'),
      payload: {
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        reportingDutiesAcknowledged: false,
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: null,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
    });

    const after = audit.log.entries().at(-1);

    expect(after).toBeDefined();
    expect(after).not.toEqual(before);
  });
});
