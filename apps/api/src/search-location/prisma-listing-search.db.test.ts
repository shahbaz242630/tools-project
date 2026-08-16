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
import type { CategoryRecord } from '../catalogue/category-store.js';
import type { NearbySearch } from './listing-search.js';
import {
  createRecordingLogger,
  createRecordingMetrics,
} from '@platform/observability/testing';
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
const metrics = createRecordingMetrics();
const search = new PrismaListingSearch(
  client,
  geocoder,
  logger.logger,
  metrics.metrics,
);

/** A full first page, for every test that is not about paging (slice 3.1d). */
const PAGE_ONE = { limit: 24, offset: 0 } as const;

/** A window of `size`, `page` pages in — the arithmetic the service does. */
function nthPage(page: number, size: number) {
  return { limit: size, offset: (page - 1) * size };
}

/**
 * One search, with the ordinary answer to everything a test is not about
 * (slice 3.2a).
 *
 * **Defaults rather than repetition, because the defaults are what most of this
 * file is testing around.** Nearly every test here is about the geometry or the
 * visibility predicate, and spelling out an origin, a radius, a null category
 * and a window at each of thirty call sites would bury the one field that
 * differs.
 *
 * **`categoryId: null` is the default deliberately**, so every test written
 * before this slice keeps asserting exactly what it asserted: an unfiltered
 * search. The filter tests are the ones that say so. **`keyword: null` joins it
 * on the same terms in slice 3.3a**, and for the same reason: every test in this
 * file predating the keyword must keep meaning what it meant.
 */
function searchFor(overrides: Partial<NearbySearch> = {}): NearbySearch {
  return {
    originPostcode: ORIGIN_POSTCODE,
    radiusMiles: 5,
    categoryId: null,
    keyword: null,
    window: PAGE_ONE,
    ...overrides,
  };
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
 * A category with an owner of its own (slice 3.2a).
 *
 * Categories need an author, and a filter test needs a category *before* it has
 * a listing — so this exists rather than reaching into `givenAListing`, which
 * mints one per listing precisely so that tests about geometry cannot collide.
 */
async function givenACategory(): Promise<CategoryRecord> {
  return newCategory(await newUser());
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
    category = null,
    title = 'Petrol lawn scarifier',
    description = 'Serviced last spring.',
  }: {
    truePoint?: Point | null;
    visible?: boolean;
    /**
     * The words this listing can be found by (slice 3.3a).
     *
     * **Settable rather than fixed, and defaulted to what every earlier test
     * already had** — so nothing written before this slice changes meaning, and
     * a keyword test says in its own body which words it expects to match. The
     * document itself is written by a database trigger from exactly these two
     * columns, so a test that sets them is exercising the real derivation rather
     * than a fixture of it.
     */
    title?: string;
    description?: string;
    /**
     * Which category to list in (slice 3.2a).
     *
     * **Null means "one of its own"**, which is what every test written before
     * this slice gets and is why they are unaffected: a listing in a category
     * nothing else shares cannot be accidentally included or excluded by a
     * filter test running beside it. A filter test passes the same category to
     * two listings on purpose, which is the only way to write one that would
     * fail if the predicate were dropped.
     */
    category?: CategoryRecord | null;
  } = {},
): Promise<string> {
  const owner = await newUser();
  const inCategory = category ?? (await newCategory(owner));

  const listing = await store.createDraft({
    ownerId: owner,
    categorySlug: inCategory.slug,
    title,
    description,
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

    const page = await search.findWithin(searchFor());

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('leaves out a listing well outside it', async () => {
    await givenAListing(northOf(milesToMetres(9)));

    const page = await search.findWithin(searchFor());

    expect(page?.matches).toEqual([]);
  });

  it('finds the same listing at a wider radius', async () => {
    const id = await givenAListing(northOf(milesToMetres(9)));

    const page = await search.findWithin(searchFor({ radiusMiles: 10 }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('holds at the boundary, on the inside', async () => {
    // Fifty metres inside five miles. PostGIS measures on the spheroid and
    // `applyFuzzOffset` places on a sphere, so the two disagree by tens of
    // metres over this distance — hence fifty rather than one.
    const id = await givenAListing(northOf(milesToMetres(5) - 50));

    const page = await search.findWithin(searchFor());

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  it('holds at the boundary, on the outside', async () => {
    await givenAListing(northOf(milesToMetres(5) + 50));

    const page = await search.findWithin(searchFor());

    expect(page?.matches).toEqual([]);
  });

  it('never matches a listing that was never geocoded', async () => {
    // §8.3 lets a draft exist with an address nothing could place, and
    // publication refuses one — but the query must not depend on that being
    // true, because `ST_DWithin` against NULL is the thing keeping it out.
    await givenAListing(null);

    const page = await search.findWithin(searchFor({ radiusMiles: 100 }));

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

    const page = await search.findWithin(searchFor());

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

    const page = await search.findWithin(searchFor());

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
      Array.from({ length: 5 }, () => search.findWithin(searchFor())),
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

    const page = await search.findWithin(searchFor());

    expect(page?.matches[0]?.distance).toEqual({ kind: 'approximate', miles: 4 });
  });

  it('returns nothing but an id and a bucket', async () => {
    // The projection ADR 0044 leans on, asserted against the real row rather
    // than against the type: this query joins `listing_locations`, and what
    // stops a street line travelling is that the SELECT names two columns.
    const published = northOf(2_000);
    const truePoint = southOf(published, ORDINARY_FUZZ);
    await givenAListing(published, { truePoint });

    const page = await search.findWithin(searchFor());
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

        const page = await search.findWithin(searchFor());
        if ((page?.matches.length ?? 0) > 0) visible.push(`${status}/${state}`);
      }
    }

    expect(visible).toEqual(['PUBLISHED/APPROVED']);
  });
});

describe('narrowing to one category (slice 3.2a)', () => {
  it('returns only listings in the category asked for', async () => {
    const wanted = await givenACategory();
    const other = await givenACategory();

    const inWanted = await givenAListing(northOf(1_000), { category: wanted });
    await givenAListing(northOf(2_000), { category: other });

    const page = await search.findWithin(searchFor({ categoryId: wanted.id }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([inWanted]);
  });

  it('returns every category when asked for none', async () => {
    const wanted = await givenACategory();
    const other = await givenACategory();

    const near = await givenAListing(northOf(1_000), { category: wanted });
    const far = await givenAListing(northOf(2_000), { category: other });

    const page = await search.findWithin(searchFor());

    expect(page?.matches.map((match) => match.listingId)).toEqual([near, far]);
  });

  /*
   * **The category filter does not loosen the other two**, which is the failure
   * a predicate added to a `WHERE` clause in the wrong place produces: an `AND`
   * that binds to the wrong side of an `OR`, or a rewrite that drops a clause
   * while the tests about it are all unfiltered.
   */
  it('still excludes a listing the visibility predicate refuses', async () => {
    const category = await givenACategory();

    const hidden = await givenAListing(northOf(1_000), {
      category,
      visible: false,
    });
    await setState(hidden, 'PUBLISHED', 'REJECTED');

    const page = await search.findWithin(searchFor({ categoryId: category.id }));

    expect(page?.matches).toEqual([]);
  });

  /*
   * **And it does not loosen the radius either.** Both predicates sit in the
   * same statement, and a listing in the right category but the wrong place is
   * the case that would pass if the geo clause were accidentally made
   * conditional alongside the category one.
   */
  it('still excludes a listing outside the radius', async () => {
    const category = await givenACategory();
    await givenAListing(northOf(milesToMetres(20)), { category });

    const page = await search.findWithin(searchFor({ categoryId: category.id }));

    expect(page?.matches).toEqual([]);
  });

  /*
   * **A category that exists but holds nothing near here is an empty page, not
   * an error** — the same treatment as an empty radius. Refusing an id that
   * resolves is the service's job only when the *slug* names nothing; by the
   * time an id reaches this repository it is a real category, and "no listings"
   * is an answer rather than a fault.
   */
  it('is an empty page for a real category with nothing in it', async () => {
    const empty = await givenACategory();
    await givenAListing(northOf(1_000));

    const page = await search.findWithin(searchFor({ categoryId: empty.id }));

    expect(page).not.toBeNull();
    expect(page?.matches).toEqual([]);
    expect(page?.truncated).toBe(false);
  });

  /*
   * **The filter runs inside the query, not after it** (ADR 0044, extended by
   * slice 3.2a). This is the filter-after-paginate bug written as a test: with a
   * page size of two and three listings in the wanted category interleaved with
   * three in another, a filter applied *after* the page was cut would return one
   * result and claim there was nothing more.
   */
  it('pages over the filtered set, not over the unfiltered one', async () => {
    const wanted = await givenACategory();
    const other = await givenACategory();

    const first = await givenAListing(northOf(1_000), { category: wanted });
    await givenAListing(northOf(1_500), { category: other });
    const second = await givenAListing(northOf(2_000), { category: wanted });
    await givenAListing(northOf(2_500), { category: other });
    const third = await givenAListing(northOf(3_000), { category: wanted });

    const page = await search.findWithin(
      searchFor({ categoryId: wanted.id, window: nthPage(1, 2) }),
    );

    expect(page?.matches.map((match) => match.listingId)).toEqual([first, second]);
    expect(page?.truncated).toBe(true);

    const next = await search.findWithin(
      searchFor({ categoryId: wanted.id, window: nthPage(2, 2) }),
    );

    expect(next?.matches.map((match) => match.listingId)).toEqual([third]);
    expect(next?.truncated).toBe(false);
  });

  /*
   * **The projection is unchanged by filtering**, which is the disclosure check
   * repeated for the new code path. Slice 3.1a proved the unfiltered statement
   * returns nothing but an id and a bucket; a composed statement is a second
   * statement, and the whole argument for `Prisma.sql` over string-building is
   * that it cannot widen a `SELECT` — proved here rather than asserted.
   */
  it('returns nothing but an id and a bucket when filtered', async () => {
    const category = await givenACategory();
    await givenAListing(northOf(1_000), { category });

    const page = await search.findWithin(searchFor({ categoryId: category.id }));
    const match = page?.matches[0];

    expect(match).toBeDefined();
    expect(Object.keys(match ?? {}).sort()).toEqual(['distance', 'listingId']);
    expect(JSON.stringify(page)).not.toContain('Ashley Down');
    expect(JSON.stringify(page)).not.toContain('BS7 8AA');
  });

  /*
   * **A slug-shaped value cannot become SQL.** The id is a bound parameter
   * inside the `Prisma.sql` fragment rather than interpolated text, so a value
   * that is not a uuid is refused by Postgres as a bad cast — not executed. It
   * cannot reach here through the application, because the service resolves a
   * slug to an id it read from the database; this asserts the fragment is
   * parameterised anyway, because that is the property the whole shape rests on.
   */
  it('refuses a category id that is not an identifier rather than running it', async () => {
    await givenAListing(northOf(1_000));

    await expect(
      search.findWithin(searchFor({ categoryId: "' OR 1=1 --" })),
    ).rejects.toThrow();
  });
});

/**
 * Narrowing to words (slice 3.3a).
 *
 * **This is the only file that can say anything about matching.** The unit fake
 * models the predicate's *shape* — that it composes with the others and runs
 * before the page is sliced — and deliberately does not model stemming, phrases
 * or punctuation, because reimplementing an English stemmer in a fake proves
 * only that two implementations agree. Everything below needs a real Postgres, a
 * real `tsvector` written by the real trigger, and `websearch_to_tsquery`.
 */
describe('narrowing to words (slice 3.3a)', () => {
  it('finds a listing by a word in its title', async () => {
    const trimmer = await givenAListing(northOf(1_000), {
      title: 'Petrol hedge trimmer',
    });
    await givenAListing(northOf(2_000), { title: 'SDS+ rotary hammer drill' });

    const page = await search.findWithin(searchFor({ keyword: 'trimmer' }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([trimmer]);
  });

  /*
   * **The description is searched too, and that is why the column is a document
   * rather than the title.** An owner who wrote "ideal for hedges" in the prose
   * and called the thing by its brand name is findable, which is most of what a
   * keyword search is for on a catalogue people describe in their own words.
   */
  it('finds a listing by a word in its description', async () => {
    const found = await givenAListing(northOf(1_000), {
      title: 'Stihl HS 45',
      description: 'Ideal for cutting a hedge.',
    });
    await givenAListing(northOf(2_000), { title: 'SDS+ rotary hammer drill' });

    const page = await search.findWithin(searchFor({ keyword: 'hedge' }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([found]);
  });

  /*
   * **The reason this is full-text search and not a `LIKE`.** Nobody types the
   * exact inflection an owner wrote, and a substring match would find `trimmer`
   * inside `trimmers` while failing the reverse — which is the direction a
   * searcher actually types.
   */
  it.each([
    ['trimmers', 'Petrol hedge trimmer'],
    ['trimmer', 'Petrol hedge trimmers'],
    ['cutting', 'Cut a hedge with it'],
  ])('matches %j against %j, because it stems', async (keyword, title) => {
    const id = await givenAListing(northOf(1_000), { title });
    /*
     * **A listing that must *not* match, and it is here because the first
     * version of this test did not have one.** With a single seeded row the
     * assertion held whether the predicate ran or not — deleting the keyword
     * fragment from the adapter left all three of these green, which is how it
     * was found. A test of a filter needs something for the filter to exclude.
     */
    await givenAListing(northOf(2_000), { title: 'SDS+ rotary hammer drill' });

    const page = await search.findWithin(searchFor({ keyword }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([id]);
  });

  /*
   * **Two words mean both of them.** `websearch_to_tsquery` reads unquoted words
   * as a conjunction, which is what somebody typing two words expects and is the
   * one semantic worth pinning: an implementation that used `plainto_tsquery`'s
   * older behaviour or an OR would return a page full of near-misses.
   */
  it('requires every word, not any of them', async () => {
    const both = await givenAListing(northOf(1_000), { title: 'Petrol hedge trimmer' });
    await givenAListing(northOf(2_000), { title: 'Petrol lawn mower' });

    const page = await search.findWithin(searchFor({ keyword: 'petrol trimmer' }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([both]);
  });

  /*
   * **Nothing a person can type is a syntax error**, which is the whole reason
   * for `websearch_to_tsquery` over `to_tsquery`. Each of these raises on the
   * older function, and each is a perfectly ordinary thing to type into a box on
   * a page anybody on the internet can load — so each would have been a 500 on
   * the most exposed route in the system.
   */
  it.each(['hedge & trimmer', '!!!', 'hedge | (trimmer', '3" drill bit', '<->'])(
    'answers %j rather than raising',
    async (keyword) => {
      await givenAListing(northOf(1_000), { title: 'Petrol hedge trimmer' });

      await expect(search.findWithin(searchFor({ keyword }))).resolves.toBeDefined();
    },
  );

  /*
   * **A quote cannot end the string**, which is the injection check the category
   * filter's twin makes about a uuid cast. The term is a bound parameter inside
   * the `Prisma.sql` fragment, so this is a search for a strange phrase rather
   * than a statement — and the assertion is that it *runs and finds nothing*,
   * not that it throws.
   */
  it('treats SQL as words rather than as SQL', async () => {
    await givenAListing(northOf(1_000), { title: 'Petrol hedge trimmer' });

    const page = await search.findWithin(
      searchFor({ keyword: "'; DROP TABLE listings; --" }),
    );

    expect(page?.matches).toEqual([]);
    // The table it named is still there, which is the half worth stating out loud.
    await expect(client.listing.count()).resolves.toBeGreaterThan(0);
  });

  /*
   * **The keyword composes with the radius rather than replacing it.** A text
   * search that quietly widened the search area would be the most plausible way
   * to break this: the words are the interesting part, and it is easy to write a
   * query where they become the only predicate.
   */
  it('still respects the radius', async () => {
    await givenAListing(northOf(milesToMetres(9)), { title: 'Petrol hedge trimmer' });

    const page = await search.findWithin(searchFor({ keyword: 'trimmer' }));

    expect(page?.matches).toEqual([]);
  });

  /** And with the category, which is the pair a real Browse search sends. */
  it('composes with the category filter', async () => {
    const wanted = await givenACategory();
    const other = await givenACategory();

    const target = await givenAListing(northOf(1_000), {
      category: wanted,
      title: 'Petrol hedge trimmer',
    });
    await givenAListing(northOf(1_200), {
      category: other,
      title: 'Petrol hedge trimmer',
    });
    await givenAListing(northOf(1_400), { category: wanted, title: 'Lawn mower' });

    const page = await search.findWithin(
      searchFor({ categoryId: wanted.id, keyword: 'trimmer' }),
    );

    expect(page?.matches.map((match) => match.listingId)).toEqual([target]);
  });

  /*
   * **And with the visibility predicate.** A keyword must not become a way to
   * reach a listing the platform has hidden — which is the one failure here that
   * would be a disclosure rather than a wrong result.
   */
  it('never surfaces a listing that is not publicly visible', async () => {
    const hidden = await givenAListing(northOf(1_000), {
      title: 'Petrol hedge trimmer',
    });
    await setState(hidden, 'PUBLISHED', 'UNDER_REVIEW');

    const page = await search.findWithin(searchFor({ keyword: 'trimmer' }));

    expect(page?.matches).toEqual([]);
  });

  /*
   * **The filter runs inside the query, not after it** — the category filter's
   * test one filter along, and the same filter-after-paginate bug.
   */
  it('pages over the matching set, not over the unmatched one', async () => {
    const first = await givenAListing(northOf(1_000), {
      title: 'Petrol hedge trimmer',
    });
    await givenAListing(northOf(1_500), { title: 'Lawn mower' });
    const second = await givenAListing(northOf(2_000), {
      title: 'Cordless hedge trimmer',
    });
    await givenAListing(northOf(2_500), { title: 'Rotary hammer drill' });
    const third = await givenAListing(northOf(3_000), {
      title: 'Long-reach hedge trimmer',
    });

    const page = await search.findWithin(
      searchFor({ keyword: 'trimmer', window: nthPage(1, 2) }),
    );

    expect(page?.matches.map((match) => match.listingId)).toEqual([first, second]);
    expect(page?.truncated).toBe(true);

    const next = await search.findWithin(
      searchFor({ keyword: 'trimmer', window: nthPage(2, 2) }),
    );

    expect(next?.matches.map((match) => match.listingId)).toEqual([third]);
    expect(next?.truncated).toBe(false);
  });

  /*
   * **Still nearest-first, and this is the product decision asserted as a test.**
   * A keyword search returns the *nearest* match rather than the best-matching
   * one — see `searchKeywordSchema`. The listing whose title is exactly the query
   * is deliberately the far one, so a `ts_rank` slipped into the `ORDER BY` would
   * fail here rather than pass unnoticed.
   */
  it('orders by distance and not by how well the words matched', async () => {
    const near = await givenAListing(northOf(1_000), {
      title: 'Petrol hedge trimmer with a long reach and other things',
      description: 'A general description mentioning nothing in particular.',
    });
    const far = await givenAListing(northOf(4_000), {
      title: 'Trimmer',
      description: 'Trimmer trimmer trimmer.',
    });

    const page = await search.findWithin(searchFor({ keyword: 'trimmer' }));

    expect(page?.matches.map((match) => match.listingId)).toEqual([near, far]);
  });

  /*
   * **The projection is unchanged**, the disclosure check repeated for the third
   * composed statement. `Prisma.sql` cannot widen a `SELECT`; proved rather than
   * asserted, because the whole shape rests on it.
   */
  it('returns nothing but an id and a bucket when keyworded', async () => {
    await givenAListing(northOf(1_000), { title: 'Petrol hedge trimmer' });

    const page = await search.findWithin(searchFor({ keyword: 'trimmer' }));
    const match = page?.matches[0];

    expect(match).toBeDefined();
    expect(Object.keys(match ?? {}).sort()).toEqual(['distance', 'listingId']);
    expect(JSON.stringify(page)).not.toContain('Ashley Down');
    expect(JSON.stringify(page)).not.toContain('BS7 8AA');
  });

  /*
   * **The document follows an edit, because the trigger fires on UPDATE too.**
   * The failure this guards is the quiet one: a listing renamed by its owner
   * stays findable under its old title and unfindable under its new one, with
   * nothing anywhere reporting it and no error to notice.
   */
  it('follows a retitled listing rather than remembering the old words', async () => {
    const id = await givenAListing(northOf(1_000), { title: 'Petrol hedge trimmer' });
    const owner = await client.listing.findUniqueOrThrow({ where: { id } });

    await store.update(id, owner.ownerId, {
      title: 'Cordless lawn mower',
      description: 'Serviced last spring.',
      replacementValue: { amount: 24_999, currency: 'GBP' },
      attributes: {},
      transportRequirement: null,
      requiresTwoPersonLift: false,
      // `address-only`, so the point this test searches from is left exactly
      // where it was — the edit under test is the title and nothing else.
      collectionLocation: {
        kind: 'address-only',
        location: {
          line1: '14 Ashley Down Road',
          line2: null,
          town: 'Bristol',
          postcode: 'BS7 8AA',
        },
      },
      rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
      categoryVersionNumber: 1,
    });

    await expect(
      search
        .findWithin(searchFor({ keyword: 'trimmer' }))
        .then((page) => page?.matches.length),
    ).resolves.toBe(0);

    await expect(
      search
        .findWithin(searchFor({ keyword: 'mower' }))
        .then((page) => page?.matches.map((match) => match.listingId)),
    ).resolves.toEqual([id]);
  });
});

describe('ordering and bounds', () => {
  it('returns the nearest first', async () => {
    // Created out of order deliberately: insertion order must not be what
    // decides the page.
    const farId = await givenAListing(northOf(6_000));
    const nearId = await givenAListing(northOf(1_000));
    const middleId = await givenAListing(northOf(4_000));

    const page = await search.findWithin(searchFor());

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

    const page = await search.findWithin(searchFor({ window: nthPage(1, 2) }));

    expect(page?.matches).toHaveLength(2);
    expect(page?.truncated).toBe(true);
  });

  it('does not claim truncation on an exactly full page', async () => {
    for (let index = 0; index < 2; index += 1) {
      await givenAListing(northOf(1_000 + index * 100));
    }

    const page = await search.findWithin(searchFor({ window: nthPage(1, 2) }));

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

    const first = await search.findWithin(searchFor({ window: nthPage(1, 2) }));
    const second = await search.findWithin(searchFor({ window: nthPage(2, 2) }));

    expect(first?.matches.map((match) => match.listingId)).toEqual(ids.slice(0, 2));
    expect(second?.matches.map((match) => match.listingId)).toEqual(ids.slice(2, 4));
  });

  it('walks the whole set exactly once, with nothing repeated or skipped', async () => {
    const ids = await givenSix();

    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        search.findWithin(searchFor({ window: nthPage(page, 2) })),
      ),
    );
    const seen = pages.flatMap(
      (page) => page?.matches.map((match) => match.listingId) ?? [],
    );

    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('says there is more until the last page, and not on it', async () => {
    await givenSix();

    const second = await search.findWithin(searchFor({ window: nthPage(2, 2) }));
    const third = await search.findWithin(searchFor({ window: nthPage(3, 2) }));

    expect(second?.truncated).toBe(true);
    expect(third?.truncated).toBe(false);
  });

  it('is an empty page past the end, not an error', async () => {
    await givenSix();

    const past = await search.findWithin(searchFor({ window: nthPage(9, 2) }));

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

    const first = await search.findWithin(searchFor({ window: nthPage(1, 2) }));
    const second = await search.findWithin(searchFor({ window: nthPage(2, 2) }));
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

    await expect(
      search.findWithin(searchFor({ originPostcode: 'ZZ99 9ZZ' })),
    ).resolves.toBeNull();
  });

  it('is null rather than a throw when the provider is unreachable', async () => {
    // The no-throw rule the port states: a third party being down must not turn
    // a search into a 500.
    geocoder.failsOnce();

    await expect(search.findWithin(searchFor())).resolves.toBeNull();
  });

  /**
   * **The two reasons a search cannot start, told apart** (slice 3.1f).
   *
   * Both return null and both are served as an empty page, which is right for
   * the searcher and useless for us: a geocoder outage would otherwise look
   * exactly like a country with no postcodes in it. This asserts the read path
   * specifically — `location.service.test.ts` asserts the write path, and both
   * go through the one helper so that neither can be forgotten.
   */
  it('records which of the two reasons it was', async () => {
    const before = metrics.geocodes.length;

    await search.findWithin(searchFor({ originPostcode: 'ZZ99 9ZZ' }));
    geocoder.failsOnce();
    await search.findWithin(searchFor());
    await search.findWithin(searchFor());

    expect(metrics.geocodes.slice(before).map((sample) => sample.outcome)).toEqual([
      'unknown',
      'unavailable',
      'found',
    ]);
  });
});
