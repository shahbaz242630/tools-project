import { Prisma } from '@platform/database';
import type { PrismaClient } from '@platform/database';
import type { ListingStatus, ModerationState } from '@platform/contracts';
import { Paging } from '@platform/core';
import type { Logger, Metrics } from '@platform/observability';
import type { PostcodeGeocoder } from './geocoder.js';
import { geocodeQuietly } from './geocode-quietly.js';
import { bucketDistance, milesToMetres } from './distance-bucket.js';
import type {
  ListingSearchRepository,
  NearbyListing,
  NearbyListingPage,
  NearbySearch,
} from './listing-search.js';

/**
 * The radius query — **the only hand-written SQL in the project** (slice 3.1a).
 *
 * Prisma has no geography support (BRD §4.2), so this is the one place the ORM
 * is stepped around, and `no-raw-sql-outside-search` is the invariant that keeps
 * it the only one. Read ADR 0044 before changing the shape of what it returns
 * and ADR 0032 before changing what it measures from.
 *
 * **Three properties of the statement below are load-bearing.**
 *
 * 1. **It filters on `fuzzedPoint`, never on the true coordinates.** ADR 0032
 *    makes that binding on this phase and the reason is worth restating, because
 *    filtering on the true point *and* displaying a fuzzed distance looks more
 *    correct and is the whole vulnerability: an attacker sets a 1-mile radius,
 *    then 2, then 3, and the radius at which a listing first appears is its true
 *    distance from an origin they chose. Three origins and it is trilaterated.
 *    Measuring from the fuzzed point makes every probe return facts about a
 *    point we publish deliberately. The GiST index is on the fuzzed pair, so the
 *    wrong option is also the slow one.
 * 2. **The visibility predicate is inside the query.** ADR 0044: filtering
 *    afterwards is the filter-after-paginate bug, and drafts are the normal
 *    state of a listing — seven of the eight local fixtures. This is the
 *    boundary crossing that ADR records: two enum columns of Catalogue's table,
 *    read as a predicate and never projected.
 * 3. **It returns an id and a bucket.** No title, no price, no address, no
 *    coordinate. There is no field on `NearbyListing` that a street line could
 *    occupy, which is what stands in for the "join that was never written"
 *    guarantee this query had to spend.
 *
 * **From slice 3.2a the statement is composed rather than fixed, and the choice
 * between the two ways of doing that is the decision in this file.** The
 * category filter is optional, so it could have been written inline as
 * `(${categoryId} IS NULL OR l."categoryId" = ${categoryId})` — one statement,
 * always the same text. That was rejected: a dead predicate on every row would
 * change the plan of **every** search, including the unfiltered one slice 3.1c
 * measured the Phase 3 exit gate against, and a gate number that no longer
 * describes the query that ships is worse than no number. A `Prisma.empty`
 * fragment leaves the unfiltered statement **byte-identical to the one 3.1c
 * timed**, so that measurement stands unchanged and only the filtered path is
 * new work to measure.
 */
export class PrismaListingSearch implements ListingSearchRepository {
  constructor(
    private readonly prisma: PrismaClient,
    /**
     * The origin postcode is geocoded on this side of the boundary, so no bare
     * coordinate is ever handed to Catalogue (ADR 0044).
     */
    private readonly geocoder: PostcodeGeocoder,
    private readonly logger: Logger,
    /**
     * Carried only to be handed to `geocodeQuietly` (slice 3.1f).
     *
     * **The search's *own* outcome is not recorded here**, and that is the
     * decision rather than an oversight: this repository cannot tell an empty
     * radius from a page past the end, because it does not know which page was
     * asked for in the searcher's terms — it was given an offset. Catalogue
     * knows, and records it there.
     */
    private readonly metrics: Metrics,
  ) {}

  async findWithin(search: NearbySearch): Promise<NearbyListingPage | null> {
    const { window } = search;

    const origin = await geocodeQuietly(
      this.geocoder,
      this.logger,
      this.metrics,
      search.originPostcode,
    );
    if (origin === null) return null;

    const radiusMetres = milesToMetres(search.radiusMiles);

    /*
     * **Absent rather than always-true when no category was chosen** (slice
     * 3.2a). See the class docblock: this is what keeps the unfiltered statement
     * byte-identical to the one slice 3.1c measured the exit gate against.
     *
     * **The id is still a bound parameter inside the fragment**, not
     * interpolated text — `Prisma.sql` carries its placeholder into the composed
     * statement, so this is not string-building SQL and a slug-shaped id cannot
     * become syntax. The cast is explicit because the column is `uuid` and the
     * parameter arrives as text; without it Postgres compares `uuid` to `text`
     * and refuses.
     */
    const inCategory =
      search.categoryId === null
        ? Prisma.empty
        : Prisma.sql`AND l."categoryId" = ${search.categoryId}::uuid`;

    /*
     * **`ST_MakePoint` takes longitude first — x then y** — which is the reverse
     * of how the pair is spoken and written everywhere else in this codebase,
     * and is the single easiest thing here to get wrong. The trigger that
     * maintains `fuzzedPoint` carries the same warning for the same reason, and
     * there is a db test that puts a listing in Bristol and asserts PostGIS
     * agrees about which way round it is.
     *
     * **Rows with no `fuzzedPoint` fall out on their own**: `ST_DWithin` against
     * NULL is NULL, which is not true, so an ungeocoded listing is never a
     * match. That is left to the SQL rather than written as an extra predicate
     * because publication already refuses a listing with no coordinates — a
     * `NOT NULL` test here would be dead code implying a case that cannot reach
     * this query.
     *
     * **`ORDER BY` carries a tiebreak on id, and from slice 3.1d it is load
     * bearing rather than tidy.** Two equidistant listings compare equal, and a
     * sort with no tiebreak makes the page order depend on whatever the planner
     * did — which is the same defect that made `listOwnedBy` flaky one run in
     * eight. Under `OFFSET` it stops being a cosmetic flake: an unstable total
     * order means a row served on page one can be served again on page two, or
     * skipped by both, and nothing anywhere would report it. **Do not remove
     * this tiebreak as redundant** — `prisma-listing-search.db.test.ts` walks
     * two pages of equidistant listings for exactly this reason.
     *
     * **`OFFSET` rather than a keyset cursor** (ADR 0045, slice 3.1d). The skip
     * is O(n) and that is measured rather than assumed to be acceptable: slice
     * 3.1c put the widest search over 50,001 listings at a p95 of 111.8 ms
     * against a 200 ms target, and the depth anybody reaches is capped at
     * `MAX_SEARCH_PAGE`. What it buys is a URL carrying no exact distance.
     */
    const rows = await this.prisma.$queryRaw<readonly DistanceRow[]>`
      SELECT l."id" AS "listingId",
             ST_Distance(
               loc."fuzzedPoint",
               ST_SetSRID(ST_MakePoint(${origin.longitude}, ${origin.latitude}), 4326)::geography
             ) AS "metres"
      FROM "listing_locations" loc
      JOIN "listings" l ON l."id" = loc."listingId"
      WHERE l."status" = ${PUBLICLY_VISIBLE_STATUS}
        AND l."moderationState" = ${PUBLICLY_VISIBLE_MODERATION}
        ${inCategory}
        AND ST_DWithin(
              loc."fuzzedPoint",
              ST_SetSRID(ST_MakePoint(${origin.longitude}, ${origin.latitude}), 4326)::geography,
              ${radiusMetres}
            )
      ORDER BY "metres" ASC, l."id" ASC
      LIMIT ${Paging.probe(window.limit)}
      OFFSET ${window.offset}
    `;

    const page = Paging.fitTo(rows, window.limit);

    return {
      matches: page.items.map(toNearbyListing),
      truncated: page.truncated,
    };
  }
}

/**
 * What the statement above returns, before any of it is allowed out.
 *
 * `metres` exists on this type and on nothing that leaves this file — it is
 * mapped to a bucket a line later. Raw SQL has no compiler checking that a
 * result matches its declared shape, so keeping this type minimal is also the
 * only thing that would make an accidentally widened `SELECT` visible.
 */
interface DistanceRow {
  readonly listingId: string;
  readonly metres: number;
}

function toNearbyListing(row: DistanceRow): NearbyListing {
  return { listingId: row.listingId, distance: bucketDistance(row.metres) };
}

/**
 * `isPubliclyVisible`, restated for a query — the third home of this rule and
 * the one that needs watching.
 *
 * `PUBLICLY_VISIBLE` in `prisma-listing-store.ts` already restates it once,
 * because the predicate has to be indexable and a TypeScript function is not.
 * This is that restatement crossing a module boundary (ADR 0044), which is why
 * both values are **typed against the contract vocabulary** rather than written
 * as bare strings: renaming a status in `@platform/contracts` fails the build
 * here rather than silently returning nothing.
 *
 * The third authority (ADR 0043) is not here. It lives in another module's table
 * and is applied by Catalogue on hydration.
 */
const PUBLICLY_VISIBLE_STATUS: ListingStatus = 'PUBLISHED';
const PUBLICLY_VISIBLE_MODERATION: ModerationState = 'APPROVED';
