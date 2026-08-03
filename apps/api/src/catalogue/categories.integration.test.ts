import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ADMIN_CATEGORIES_PATH,
  ME_PATH,
  adminCategoryPath,
  parseAdminCategory,
  parseAdminCategoryList,
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
import { InMemoryCategoryStore } from './testing/fakes.js';

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
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(store, audit.service),
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

const createPath = `${ADMIN_CATEGORIES_PATH}?reason=${encodeURIComponent(REASON)}`;

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
    const response = await app.inject({ method: 'GET', url: ADMIN_CATEGORIES_PATH });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an ordinary signed-in user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_PATH,
      headers: auth('bob-token'),
    });
    // 403, not 404: the route exists and they are simply not allowed to use it.
    expect(response.statusCode).toBe(403);
  });

  it('refuses an ordinary user trying to create one', async () => {
    const response = await createCategory('bob-token');
    expect(response.statusCode).toBe(403);
    expect(await store.list()).toHaveLength(0);
  });

  it('refuses an administrator whose second factor is stale', async () => {
    await promoteAdmin();

    // ADR 0021: the role is not enough. A token carrying no recent `fva` proof
    // is refused, and this is the test that would fail if the guard stopped
    // asking — the role check alone would pass here.
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_CATEGORIES_PATH,
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
      url: ADMIN_CATEGORIES_PATH,
      headers: auth('admin-token'),
      payload: { ...DRAFT },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a reason too short to mean anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${ADMIN_CATEGORIES_PATH}?reason=${encodeURIComponent('why')}`,
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
      payload: { name: 'Garden and outdoor', riskLevel: 'medium' },
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
      payload: { name: 'Nothing', riskLevel: 'low' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an ordinary user', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: configurePath('outdoor-gardening', 'should not be possible'),
      headers: auth('bob-token'),
      payload: { name: 'Hijacked', riskLevel: 'high' },
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
      payload: { name: 'Renamed', riskLevel: 'low', slug: 'something-else' },
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
      url: ADMIN_CATEGORIES_PATH,
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
      url: ADMIN_CATEGORIES_PATH,
      headers: auth('admin-token'),
    });
    expect(response.statusCode).toBe(200);
  });
});
