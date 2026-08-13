import type { PrismaClient } from '@platform/database';
import type {
  ListingStatus,
  ModerationState,
  SearchRadiusMiles,
} from '@platform/contracts';
import { Paging } from '@platform/core';
import type { Logger } from '@platform/observability';
import type { PostcodeGeocoder } from './geocoder.js';
import { geocodeQuietly } from './geocode-quietly.js';
import { bucketDistance, milesToMetres } from './distance-bucket.js';
import type {
  ListingSearchRepository,
  NearbyListing,
  NearbyListingPage,
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
  ) {}

  async findWithin(
    originPostcode: string,
    radiusMiles: SearchRadiusMiles,
    limit: number,
  ): Promise<NearbyListingPage | null> {
    const origin = await geocodeQuietly(this.geocoder, this.logger, originPostcode);
    if (origin === null) return null;

    const radiusMetres = milesToMetres(radiusMiles);

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
     * **`ORDER BY` carries a tiebreak on id.** Two equidistant listings compare
     * equal, and a sort with no tiebreak makes the page order depend on
     * whatever the planner did — which is the same defect that made
     * `listOwnedBy` flaky one run in eight, arriving here as a row that moves
     * between pages.
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
        AND ST_DWithin(
              loc."fuzzedPoint",
              ST_SetSRID(ST_MakePoint(${origin.longitude}, ${origin.latitude}), 4326)::geography,
              ${radiusMetres}
            )
      ORDER BY "metres" ASC, l."id" ASC
      LIMIT ${Paging.probe(limit)}
    `;

    const page = Paging.fitTo(rows, limit);

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
