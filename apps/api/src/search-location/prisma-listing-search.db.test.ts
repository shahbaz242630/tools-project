/**
 * The radius query against a real PostGIS.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 *
 * **This file carries the exit gate of Phase 3.** BRD §14: *"Search returns
 * correct items inside/outside radii using integration test fixtures … and
 * passes the trilateration test in §11.2."* The fake in `testing/fakes.ts`
 * exercises the probe, the ordering and the bucketing; nothing but a real
 * database can say which point the filter measured from, and that is the whole
 * privacy control (ADR 0032).
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { LISTING_STATUSES, MODERATION_STATES } from '@platform/contracts';
import type { ListingStatus, ModerationState } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { PrismaCategoryStore } from '../catalogue/prisma-category-store.js';
import { PrismaListingStore } from '../catalogue/prisma-listing-store.js';
import type { LocatedListingPoint } from '../catalogue/listing-locator.js';
import { PrismaListingSearch } from './prisma-listing-search.js';
import { FakeGeocoder } from './testing/fakes.js';
import { applyFuzzOffset, distanceMetres } from './fuzz.js';
import type { Point } from './fuzz.js';
import { milesToMetres } from './distance-bucket.js';

const env = loadEnv();

const client = createPrismaClient({
  connectionString: buildPostgresUrl({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_TEST_DB,
  }),
});

const categories = new PrismaCategoryStore(client);
const store = new PrismaListingStore(
  client,
  createFieldEncryptor(Buffer.alloc(32, 7).toString('base64')),
);

const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};

/**
 * Where every search in this file starts.
 *
 * A real point in open country south of Bristol rather than a round number, so
 * nothing passes because a coordinate happened to be zero.
 */
const ORIGIN: Point = { latitude: 51.35, longitude: -2.6 };
const ORIGIN_POSTCODE = 'BS40 5AA';

/** Due north of the origin by `metres`. Bearing 0°, so the maths is legible. */
function northOf(metres: number): Point {
  return applyFuzzOffset(ORIGIN, { bearingDegrees: 0, distanceMetres: metres });
}

/** Due south of a point by `metres`, for placing a true point under a published one. */
function southOf(point: Point, metres: number): Point {
  return applyFuzzOffset(point, { bearingDegrees: 180, distanceMetres: metres });
}

/**
 * A plausible displacement, used wherever a test is not about the fuzz.
 *
 * **Every fixture has one, because the database insists**:
 * `fuzz_offset_is_within_bounds` refuses anything under BRD §8.4.1's 500 m
 * floor, so a listing whose true and published points coincide cannot be
 * written — which is the constraint doing its job, and is worth knowing before
 * writing a fixture that tries.
 */
const ORDINARY_FUZZ = 700;

/**
 * A listing's six location values, with the true and published points placed
 * independently.
 *
 * **The whole point of this helper is that they are set separately.** Production
 * derives one from the other, and a fixture that did the same could not express
 * the case the trilateration test needs: a listing whose true point is inside a
 * radius and whose published point is outside it.
 *
 * The offset columns are set to the real displacement between them, so the row
 * satisfies `fuzz_offset_is_within_bounds` and describes a listing that could
 * genuinely exist.
 */
function locatedAt(truePoint: Point, publishedPoint: Point): LocatedListingPoint {
  return {
    latitude: truePoint.latitude,
    longitude: truePoint.longitude,
    fuzzBearingDegrees: publishedPoint.latitude > truePoint.latitude ? 0 : 180,
    fuzzDistanceMetres: Math.round(distanceMetres(truePoint, publishedPoint)),
    fuzzedLatitude: publishedPoint.latitude,
    fuzzedLongitude: publishedPoint.longitude,
  };
}

const geocoder = new FakeGeocoder().knows({
  postcode: ORIGIN_POSTCODE,
  latitude: ORIGIN.latitude,
  longitude: ORIGIN.longitude,
});

const logger = createRecordingLogger();
const search = new PrismaListingSearch(client, geocoder, logger.logger);

/** A full first page, for every test that is not about paging (slice 3.1d). */
const PAGE_ONE = { limit: 24, offset: 0 } as const;

/** A window of `size`, `page` pages in — the arithmetic the service does. */
function nthPage(page: number, size: number) {
  return { limit: size, offset: (page - 1) * size };
}

async function newUser(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
    },
  });
  return user.id;
}

async function newCategory(authorId: string) {
  return categories.create(
    {
      slug: `cat-${randomUUID().slice(0, 8)}`,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: [],
      feePolicy: FEE_POLICY,
      transportOptions: [],
    },
    authorId,
  );
}

/**
 * A publicly visible listing, placed by **where it is published**.
 *
 * The published point is the argument rather than the true one, because that is
 * the point every assertion in this file is about: it is what the radius filter
 * measures from and what the bucket describes. The true point defaults to an
 * ordinary displacement below it, so a test that is not about the fuzz does not
 * have to think about it — and the trilateration tests override it, which is the
 * only reason it is settable at all.
 */
async function givenAListing(
  publishedPoint: Point | null,
  {
    truePoint = publishedPoint === null ? null : southOf(publishedPoint, ORDINARY_FUZZ),
    visible = true,
  }: { truePoint?: Point | null; visible?: boolean } = {},
): Promise<string> {
  const owner = await newUser();
  const category = await newCategory(owner);

  const listing = await store.createDraft({
    ownerId: owner,
    categorySlug: category.slug,
    title: 'Petrol lawn scarifier',
    description: 'Serviced last spring.',
    replacementValue: { amount: 24_999, currency: 'GBP' },
    attributes: {},
    transportRequirement: null,
    requiresTwoPersonLift: false,
    collectionLocation: {
      line1: '14 Ashley Down Road',
      line2: null,
      town: 'Bristol',
      postcode: 'BS7 8AA',
    },
    locatedPoint:
      truePoint === null || publishedPoint === null
        ? null
        : locatedAt(truePoint, publishedPoint),
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
    categoryVersionNumber: 1,
  });

  if (visible) await store.publish(listing.id, owner);

  return listing.id;
}

/** Put a listing into one of the nine status × moderation combinations. */
async function setState(
  listingId: string,
  status: ListingStatus,
  state: ModerationState,
): Promise<void> {
  const row = await client.listing.findUniqueOrThrow({ where: { id: listingId } });

  if (status !== 'DRAFT') await store.publish(listingId, row.ownerId);
  if (status === 'PAUSED') await store.pause(listingId, row.ownerId);

  await store.moderate({
    listingId,
    state,
    reason: state === 'APPROVED' ? null : 'Because the test says so',
    moderatorId: row.ownerId,
    decidedAt: new Date(),
  });
}

beforeEach(async () => {
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  await client.sellerTaxProfile.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  await client.authenticationEvent.deleteMany();
  await client.featureFlagOverride.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('what falls inside a radius', () => {
  it('finds a listing well within it', async () => {
    const id = await givenAListing(northOf(3_000));

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('leaves out a listing well outside it', async () => {
    await givenAListing(northOf(milesToMetres(9)));

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    expect(page?.matches).toEqual([]);
  });

  it('finds the same listing at a wider radius', async () => {
    const id = await givenAListing(northOf(milesToMetres(9)));

    const page = await search.findWithin(ORIGIN_POSTCODE, 10, PAGE_ONE);

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('holds at the boundary, on the inside', async () => {
    // Fifty metres inside five miles. PostGIS measures on the spheroid and
    // `applyFuzzOffset` places on a sphere, so the two disagree by tens of
    // metres over this distance — hence fifty rather than one.
    const id = await givenAListing(northOf(milesToMetres(5) - 50));

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('holds at the boundary, on the outside', async () => {
    await givenAListing(northOf(milesToMetres(5) + 50));

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    expect(page?.matches).toEqual([]);
  });

  it('never matches a listing that was never geocoded', async () => {
    // §8.3 lets a draft exist with an address nothing could place, and
    // publication refuses one — but the query must not depend on that being
    // true, because `ST_DWithin` against NULL is the thing keeping it out.
    await givenAListing(null);

    const page = await search.findWithin(ORIGIN_POSTCODE, 100, PAGE_ONE);

    expect(page?.matches).toEqual([]);
  });
});

/**
 * **The trilateration test BRD §11.2 asks for, and §14 gates the phase on.**
 *
 * §8.4.1 opens by describing the attack: query from three postcodes with a
 * narrowing radius and the exact address falls out. ADR 0032 says the defence is
 * that the *filter* runs on the fuzzed point, not merely the displayed distance
 * — and warns that filtering on the true coordinate while displaying a fuzzed
 * one looks more correct and destroys the whole control.
 *
 * The two tests below are the sharpest form of that assertion available. Each
 * constructs a listing whose true and published points fall on *opposite sides*
 * of the radius boundary, so the two implementations give opposite answers and
 * no amount of rounding can confuse them.
 */
describe('the trilateration defence', () => {
  const RADIUS_METRES = milesToMetres(5);
  /** A displacement inside the §8.4.1 range, so the fixture is a real listing. */
  const FUZZ = 900;

  it('excludes a listing whose true point is inside but whose published point is not', async () => {
    const truePoint = northOf(RADIUS_METRES - 450);
    const publishedPoint = northOf(RADIUS_METRES - 450 + FUZZ);

    await givenAListing(publishedPoint, { truePoint });

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    /*
     * **If this comes back with the listing, the filter is on the true point**
     * and the radius control is an oracle: an attacker widens it one step at a
     * time and learns the true distance from an origin they chose, three times
     * over.
     */
    expect(page?.matches).toEqual([]);
  });

  it('includes a listing whose published point is inside but whose true point is not', async () => {
    const truePoint = northOf(RADIUS_METRES + 450);
    const publishedPoint = northOf(RADIUS_METRES + 450 - FUZZ);

    const id = await givenAListing(publishedPoint, { truePoint });

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    // The mirror image, and it is worth having separately: a filter that ANDed
    // the two points together would pass the test above and fail this one.
    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('reports the same distance every time it is asked', async () => {
    // The averaging attack §8.4.1 names: a point re-fuzzed per request leaks the
    // true one through the mean of what it published. The offset is stored, so
    // repeated probes are all the same probe.
    await givenAListing(northOf(3_000 + FUZZ), { truePoint: northOf(3_000) });

    const probes = await Promise.all(
      Array.from({ length: 5 }, () => search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE)),
    );

    const distances = probes.map((page) => JSON.stringify(page?.matches));
    expect(new Set(distances).size).toBe(1);
  });

  it('measures the bucket from the published point, not the true one', async () => {
    // Three miles of true distance, displaced outward far enough to land the
    // published point in the next bucket up. What comes back must be the
    // published one — the number a searcher sees is about a place we chose.
    const truePoint = northOf(milesToMetres(2.9));
    const publishedPoint = northOf(milesToMetres(3.6));

    await givenAListing(publishedPoint, { truePoint });

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    expect(page?.matches[0]?.distance).toEqual({ kind: 'approximate', miles: 4 });
  });

  it('returns nothing but an id and a bucket', async () => {
    // The projection ADR 0044 leans on, asserted against the real row rather
    // than against the type: this query joins `listing_locations`, and what
    // stops a street line travelling is that the SELECT names two columns.
    const published = northOf(2_000);
    const truePoint = southOf(published, ORDINARY_FUZZ);
    await givenAListing(published, { truePoint });

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);
    const serialised = JSON.stringify(page?.matches);

    expect(Object.keys(page?.matches[0] ?? {}).sort()).toEqual([
      'distance',
      'listingId',
    ]);
    expect(serialised).not.toContain('Ashley Down');
    expect(serialised).not.toContain('BS7 8AA');
    expect(serialised).not.toContain(String(truePoint.latitude));
    expect(serialised).not.toContain(String(published.latitude));
    expect(serialised).not.toContain('metres');
  });
});

describe('what a search may see', () => {
  /*
   * **All nine status × moderation pairs, one visible.** The same shape as the
   * public listing page's test, and here it is holding a *second* restatement of
   * `isPubliclyVisible` — this time in hand-written SQL crossing a module
   * boundary (ADR 0044), where a compiler checks nothing at all.
   */
  it('is exactly one of the nine status and moderation pairs', async () => {
    const visible: string[] = [];

    for (const status of LISTING_STATUSES) {
      for (const state of MODERATION_STATES) {
        await client.listing.deleteMany();

        const id = await givenAListing(northOf(2_000), { visible: false });
        await setState(id, status, state);

        const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);
        if ((page?.matches.length ?? 0) > 0) visible.push(`${status}/${state}`);
      }
    }

    expect(visible).toEqual(['PUBLISHED/APPROVED']);
  });
});

describe('ordering and bounds', () => {
  it('returns the nearest first', async () => {
    // Created out of order deliberately: insertion order must not be what
    // decides the page.
    const farId = await givenAListing(northOf(6_000));
    const nearId = await givenAListing(northOf(1_000));
    const middleId = await givenAListing(northOf(4_000));

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE);

    expect(page?.matches.map((match) => match.listingId)).toEqual([
      nearId,
      middleId,
      farId,
    ]);
  });

  it('honours the limit and says there were more', async () => {
    for (let index = 0; index < 4; index += 1) {
      await givenAListing(northOf(1_000 + index * 100));
    }

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(1, 2));

    expect(page?.matches).toHaveLength(2);
    expect(page?.truncated).toBe(true);
  });

  it('does not claim truncation on an exactly full page', async () => {
    for (let index = 0; index < 2; index += 1) {
      await givenAListing(northOf(1_000 + index * 100));
    }

    const page = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(1, 2));

    expect(page?.matches).toHaveLength(2);
    expect(page?.truncated).toBe(false);
  });
});

/**
 * Paging, against the real statement (slice 3.1d).
 *
 * **This is where offset pagination is actually proved.** The fake can show that
 * a service asked for the right window; only Postgres can show that `OFFSET` and
 * `ORDER BY` compose into a stable total order — and the ways that fails are all
 * quiet. A row served on two pages, a row served on neither, or a second page
 * that is silently the first again all render as a perfectly ordinary grid.
 */
describe('paging through the results', () => {
  /** Six listings at distinct distances, nearest first by construction. */
  async function givenSix(): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await givenAListing(northOf(1_000 + index * 300)));
    }
    return ids;
  }

  it('serves the second page from where the first stopped', async () => {
    const ids = await givenSix();

    const first = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(1, 2));
    const second = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(2, 2));

    expect(first?.matches.map((match) => match.listingId)).toEqual(ids.slice(0, 2));
    expect(second?.matches.map((match) => match.listingId)).toEqual(ids.slice(2, 4));
  });

  it('walks the whole set exactly once, with nothing repeated or skipped', async () => {
    const ids = await givenSix();

    const pages = await Promise.all(
      [1, 2, 3].map((page) => search.findWithin(ORIGIN_POSTCODE, 5, nthPage(page, 2))),
    );
    const seen = pages.flatMap(
      (page) => page?.matches.map((match) => match.listingId) ?? [],
    );

    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('says there is more until the last page, and not on it', async () => {
    await givenSix();

    const second = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(2, 2));
    const third = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(3, 2));

    expect(second?.truncated).toBe(true);
    expect(third?.truncated).toBe(false);
  });

  it('is an empty page past the end, not an error', async () => {
    await givenSix();

    const past = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(9, 2));

    expect(past?.matches).toEqual([]);
    expect(past?.truncated).toBe(false);
  });

  /**
   * Equidistant listings across a page boundary — a block of flats, or two
   * neighbours, which is not a contrived case.
   *
   * **This test is weaker than it looks, and that is recorded rather than
   * glossed.** It was written to prove that `ORDER BY "metres" ASC, l."id" ASC`
   * is load-bearing under `OFFSET`: with tied sort keys and no tiebreak,
   * Postgres is free to order two statements differently, and a row served on
   * page one is then served again on page two or by neither — silently, with
   * both pages looking correct.
   *
   * **It was checked by removing the tiebreak, and it still passed** — twice,
   * once with a row rewritten between the two page reads to shift the heap.
   * Four rows is small enough that the plan is deterministic, and no fixture
   * this file can build is not. So what this actually guards is the gross
   * failure — a lost `ORDER BY`, or offset arithmetic that repeats a row — and
   * **not** the tie itself.
   *
   * The tiebreak stays regardless: Postgres guarantees nothing about tied rows,
   * and the case that breaks it is a plan change at a scale no test here
   * reaches. That is an argument from the manual rather than from evidence, and
   * it is written down as such (ADR 0045).
   */
  it('does not repeat or drop an equidistant listing across a page boundary', async () => {
    const samePoint = northOf(2_000);
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await givenAListing(samePoint));
    }

    const first = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(1, 2));
    const second = await search.findWithin(ORIGIN_POSTCODE, 5, nthPage(2, 2));
    const seen = [...(first?.matches ?? []), ...(second?.matches ?? [])].map(
      (match) => match.listingId,
    );

    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});

describe('an origin that cannot be placed', () => {
  it('is null rather than an error', async () => {
    await givenAListing(northOf(1_000));

    await expect(search.findWithin('ZZ99 9ZZ', 5, PAGE_ONE)).resolves.toBeNull();
  });

  it('is null rather than a throw when the provider is unreachable', async () => {
    // The no-throw rule the port states: a third party being down must not turn
    // a search into a 500.
    geocoder.failsOnce();

    await expect(search.findWithin(ORIGIN_POSTCODE, 5, PAGE_ONE)).resolves.toBeNull();
  });
});
