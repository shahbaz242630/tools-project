import { CALENDAR_OCCUPYING_STATES } from '../booking/booking-state-machine.js';
import { periodFromLocalDates } from '../booking/local-period.js';
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
 *
 * **Slice 3.3a adds a second optional fragment on the same terms**, and one
 * thing about it is worth stating because it is what a later reader will want to
 * "improve": **the keyword does not touch the `ORDER BY`.** A text search that
 * did not rank by relevance looks like an oversight and is a decision — §8.4
 * requires ranking to be explainable, this is a hyperlocal marketplace where
 * nearest-first *is* the product, and `ts_rank` in the sort would replace a
 * total order the paging depends on (ADR 0045) with a score that ties freely.
 * Ranking by relevance is a change to make deliberately, with a tiebreak and a
 * paging test, not one to slip into a `SELECT`.
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
     * **The same absent-rather-than-always-true treatment, for the same reason**
     * (slice 3.3a). An unkeyworded search must remain the statement slice 3.1c
     * measured the exit gate against, and `(${keyword} IS NULL OR …)` would put
     * a dead predicate on every row of every search on the platform.
     *
     * **`websearch_to_tsquery` rather than `to_tsquery`, and that is a
     * robustness decision rather than a stylistic one.** `to_tsquery` raises a
     * syntax error on input it cannot parse — so a searcher typing `&`, `!`, an
     * unbalanced bracket or two words with a space would get a 500 from the one
     * public route anybody on the internet can call. `websearch_to_tsquery`
     * parses anything: it takes what a person types, treats quoted runs as
     * phrases and bare words as an AND, and never throws.
     *
     * **The term is a bound parameter, never interpolated**, exactly as the
     * category id is — `Prisma.sql` carries its placeholder into the composed
     * statement, so this is not string-building SQL and nothing a searcher types
     * can become syntax. That is the control; the length bound in the contract
     * is the second one, and it is about cost rather than injection.
     *
     * **`'english'` as a literal here too.** The trigger that writes the column
     * uses the same literal, and the two must agree — a session with a different
     * `default_text_search_config` would stem the query by rules the document
     * was not written under, and the symptom is not an error but a listing that
     * quietly stops matching its own title.
     */
    const matchesKeyword =
      search.keyword === null
        ? Prisma.empty
        : Prisma.sql`AND l."searchDocument" @@ websearch_to_tsquery('english', ${search.keyword})`;

    /*
     * **Free for the whole period, asked inside the radius query** (slice 4.9).
     *
     * ## Why it is here and not a filter afterwards
     *
     * ADR 0046 settled this for the category and the reasoning is identical: a
     * predicate applied *after* `LIMIT`/`OFFSET` is the filter-after-paginate
     * bug. Page one would come back short, page two would skip rows, and
     * `truncated` would describe a set nobody was shown. So availability has to
     * narrow the same statement the radius does.
     *
     * ## Why this file reads two of Booking's tables
     *
     * It is a **predicate-only read, never projected** — the shape ADR 0044
     * already permits for `listings.status` and `listings.moderationState`, and
     * the module invariant forbids cross-module *writes*. Nothing about a block
     * or a booking leaves this query: no id, no renter, no note, no money. What
     * comes out is the same listing id and distance an undated search returns.
     *
     * The alternative — Booking answering *which of these are free* through a
     * port — is the filter-after-paginate bug wearing a port's clothes, because
     * the only ids it could be handed are the ones already paginated.
     *
     * ## The two halves, and the one that is easy to get wrong
     *
     * **A block** is the owner saying no, and any overlap disqualifies.
     *
     * **A booking** disqualifies only in §8.5.1's nine calendar-occupying
     * states, read from the same constant `reasonUnavailable` and the calendar
     * use. **`REQUESTED` is deliberately not among them** (§7.1): several
     * renters may hold a request for one period and the first acceptance takes
     * it, so hiding a listing because somebody else has *asked* would remove it
     * from search on the strength of a request that reserves nothing — and would
     * let one person quietly suppress a listing by requesting it.
     *
     * **The comparison is half-open at both ends**, matching the `EXCLUDE`
     * constraint, the trigger that builds `period` and `overlaps()` in the
     * availability adapter: a hire ending as another begins does not overlap,
     * which is what lets a Friday return and a Friday collection both happen.
     * The bounds are built here from the inclusive dates the wire carries — the
     * one conversion this file performs, and it is the same one
     * `local-period.ts` performs for a booking.
     *
     * **Absent rather than always-true when no dates were chosen**, exactly as
     * the category and keyword fragments are, so an undated search stays the
     * statement slice 3.1c measured the exit gate against.
     */
    /*
     * **`periodFromLocalDates`, not arithmetic written again here.** It is the
     * function the calendar and the quote engine already use, so *"the 20th to
     * the 22nd"* has one meaning in this system rather than three — and the
     * third copy is exactly where they would drift. It is also the only place
     * this file touches a timezone.
     */
    const period =
      search.dates === null
        ? null
        : periodFromLocalDates(search.dates.from, search.dates.to);

    /*
     * **`period && tstzrange(…)`, not two comparisons on the bounds** — slice
     * 4.9a, and the reason is a measurement rather than taste.
     *
     * The two forms are equivalent: `period` is `tstzrange(startAt, endAt,
     * '[)')`, maintained by trigger on both tables, so `startAt < to AND endAt >
     * from` and `period && [from, to)` select exactly the same rows. What
     * differs is what an index can serve. **A GiST index cannot answer a pair of
     * btree comparisons**, so the bounds form could not reach
     * `availability_blocks_listingId_period_idx` — and without it Postgres
     * seq-scanned the table once per candidate listing, turning the widest dated
     * search into **p95 1945 ms against a 200 ms target**.
     *
     * Measured, because neither half works alone: the index without this rewrite
     * is 1429 ms, this rewrite without the index is 1490 ms, **both together are
     * 207 ms**. Do not "simplify" either back.
     *
     * **Safe because both tables assert `period IS NOT NULL`** —
     * `block_period_is_present` and `booking_period_is_present`. The column is
     * nullable in the datamodel only because Prisma cannot express `tstzrange`,
     * and a NULL would be invisible to `&&`: a blocked listing that searched as
     * free. The CHECK is what makes that unreachable, and it is load-bearing for
     * this predicate rather than incidental.
     *
     * **`'[)'` is the same half-open bound `local-period.ts` and both triggers
     * use**, so a hire may start the instant a block ends with no gap and no
     * overlap. A `'[]'` here would make touching periods collide.
     *
     * **Not called `window`**, which is the obvious name and is already taken at
     * the top of this method by the *pagination* window. It was written that way
     * first and the integration suite refused to compile — worth a line, because
     * the two meanings of "window" are both natural here and the shadowing one
     * would have broken `LIMIT`/`OFFSET` rather than the dates.
     */
    const wantedRange =
      period === null
        ? Prisma.empty
        : Prisma.sql`tstzrange(${period.startAt}, ${period.endAt}, '[)')`;

    const freeForDates =
      period === null
        ? Prisma.empty
        : Prisma.sql`
        AND NOT EXISTS (
          SELECT 1 FROM "availability_blocks" b
          WHERE b."listingId" = l."id"
            AND b."period" && ${wantedRange}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "bookings" bk
          WHERE bk."listingId" = l."id"
            AND bk."state" = ANY(${[...CALENDAR_OCCUPYING_STATES]}::text[])
            AND bk."period" && ${wantedRange}
        )`;

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
        ${matchesKeyword}
        ${freeForDates}
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
