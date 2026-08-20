# 49. Search reads Booking's availability as a predicate, inside the radius query

Date: 2026-08-19

## Status

Accepted. Extends [ADR 0044](0044-the-radius-query-crosses-two-boundaries.md)
and [ADR 0046](0046-the-category-filter-is-a-predicate-not-a-second-pass.md).

## Context

BRD §8.4 was amended on 15 August 2026 to move the date filter from Phase 3 into
Phase 4, beside the availability calendar it filters against. Slice 4.9 builds
it: a searcher names a period, and only listings free for the whole of it come
back.

"Free" is not Search & Location's fact. It is two of Booking's tables —
`availability_blocks`, where an owner declares dates unavailable, and `bookings`,
where §8.5.1's nine calendar-occupying states hold them. Search owns neither.

The obvious boundary-respecting design is a port: Booking answers _which of these
listings are free for this period_, and Search filters its results by the answer.

**That design is the filter-after-paginate bug.** ADR 0046 settled the same
question for the category filter and the reasoning is unchanged: the radius query
ends in `LIMIT`/`OFFSET`, so the only ids a port could be handed are the ones
already paginated. Removing rows afterwards makes page one come back short, page
two skip listings nobody saw, and `truncated` describe a set that was never
served. A searcher would page through gaps.

So the predicate has to narrow the same statement the radius does — which means
`search-location/` reads two tables belonging to another module.

## Decision

**The availability predicate lives inside the radius query, and
`prisma-listing-search.ts` reads `availability_blocks` and `bookings` directly.**

Four constraints make that safe, and all four are load-bearing:

1. **Predicate only, never projected.** Nothing about a block or a booking leaves
   the query. What comes back is the same `listingId` and `metres` an undated
   search returns — asserted by a test that reads the keys off a match. This is
   the shape ADR 0044 already permits for `listings.status` and
   `listings.moderationState`.

2. **Reads only.** The module invariant in `CLAUDE.md` forbids cross-module
   database _writes_; `pnpm invariants` enforces it by mapping every Prisma model
   to an owning module and flagging a write verb on another module's table. This
   adds no write.

3. **The state vocabulary is imported, not restated.**
   `CALENDAR_OCCUPYING_STATES` comes from `booking/booking-state-machine.ts`, the
   same constant `reasonUnavailable` and the calendar use. A second list is how
   search comes to disagree with the request path about a single day.

4. **The date-to-instant conversion is imported, not rewritten.**
   `periodFromLocalDates` from `booking/local-period.ts`, so _"the 20th to the
   22nd"_ has one meaning in this system rather than three.

**`REQUESTED` is not among the nine, and that is the substance rather than a
detail.** §7.1 makes a request deliberately non-blocking: several renters may
hold one for the same period and the first acceptance takes it. A search that
hid a listing because somebody had _asked_ for it would remove it from the
catalogue on the strength of a request that binds nobody — and would let anyone
suppress a competitor's listing by requesting it and walking away. There is a db
test that asserts a `REQUESTED` booking does **not** hide a listing, and removing
the state filter fails it.

**An absent filter contributes no SQL at all**, as ADR 0046 requires, so an
undated search remains the statement slice 3.1c measured the Phase 3 exit gate
against.

## Consequences

**Search & Location now depends on Booking.** It was the module with the fewest
dependencies; it now imports two symbols from `booking/` and names two of its
tables in SQL. A change to either table's shape has a reader that grepping
Booking will not find — the same debt ADR 0044 took on for Catalogue's columns,
now doubled.

**The performance number was measured on 20 August 2026, and the dated query
misses the target by an order of magnitude.** This section previously said the
measurement was available but unrun. It has now been run, against 50,002 listings
with a seeded calendar — 20,002 bookings (12,002 of them calendar-occupying) and
5,000 availability blocks — and the result is a defect rather than a number:

| Search, London, 100 mi               | p50       | p95           |
| ------------------------------------ | --------- | ------------- |
| Undated (the Phase 3 gate statement) | 112.3 ms  | **134.1 ms**  |
| Dated, three days                    | 1638.3 ms | **1945.1 ms** |
| Dated, deepest page                  | 1509.7 ms | 1744.3 ms     |

Against a 200 ms target, the dated widest search is **14.5× the undated one**.
Every narrower radius passes comfortably — 5 to 50 miles run 17–90 ms — so the
cost is not the predicate itself but how it scales with the candidate set.

**The cause is a plan choice, not the query, and it was proved rather than
inferred.** `EXPLAIN ANALYZE` shows Postgres sequentially scanning
`availability_blocks`, materialising the 1,478 rows that fall in the window, and
then walking that list once per candidate listing — **19,241,290 join-filter
comparisons** for 13,016 candidates. The `bookings` half of the same statement
uses an index and costs about 88 ms. Re-running with `enable_seqscan = off`
takes the identical statement from **1945 ms to 212 ms**, which is what makes the
diagnosis a measurement rather than a theory.

**Why the planner chooses it: `ST_DWithin` estimates `rows=5` where the truth is
13,016**, a 2,600× underestimate. At five candidate rows, "scan the small table
once and materialise" genuinely is cheaper than 5 index probes. The estimate is
what is wrong, and the plan is a reasonable answer to a false question.

**The pathology is worst for a young marketplace, which is the uncomfortable
part.** Cost is roughly _candidates × blocks-in-window_, so it grows with the
catalogue on one axis and with adoption of the availability calendar on the
other. A smaller `availability_blocks` makes the seq scan cheaper but does not
stop the planner choosing it; a larger one eventually makes the index attractive
again. The band in between is where we are.

**Fixed the same day, in slice 4.9a, and the fix is two changes that are useless
apart.** `availability_blocks` gained the composite GiST index on
`("listingId", "period")` that `bookings` has had all along — it comes free with
§8.5.1's `EXCLUDE` constraint, which this table deliberately has no equivalent of
because an `EXCLUDE` cannot span two tables. And the predicate moved from
`"startAt" < to AND "endAt" > from` to `"period" && tstzrange(from, to, '[)')`,
because **a GiST index cannot answer a pair of btree comparisons**.

| Form                                            | p95, London 100 mi |
| ----------------------------------------------- | ------------------ |
| Bounds comparison, no index (as shipped in 4.9) | 1945 ms            |
| Composite index, bounds comparison              | 1429 ms            |
| Overlap operator, no composite index            | 1490 ms            |
| **Overlap operator + composite index**          | **~250 ms**        |

Both anti-joins are now index-only scans with zero heap fetches. **Nine of the
ten radius-and-origin combinations pass**; London at 100 miles sits at roughly
215–280 ms across runs, against a 200 ms target — see _the target_ below.

**Four faster-looking rewrites were measured and rejected**, which is the part
worth keeping because each looks like an improvement:

| Rewrite                                | p95     | Why it was rejected                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOT IN` over a `UNION ALL`            | 157 ms  | **Abandons the spatial index.** The plan flips to a parallel sequential scan of the whole `listings` table, so cost scales with the catalogue rather than the radius, and buffer traffic rises from 105k to 140k. Faster at 50,000 rows and worse at every size above it |
| `NOT EXISTS` over a subquery           | 4601 ms | The correlation cannot be pushed into the union branches, so it re-evaluates per row                                                                                                                                                                                     |
| `NOT EXISTS` over a `MATERIALIZED` CTE | 5361 ms | Computes the set once, then sequentially scans it per candidate — the CTE has no index                                                                                                                                                                                   |
| `LEFT JOIN … IS NULL`                  | 4375 ms | The canonical safe anti-join, and the `rows=5` estimate makes the planner nest-loop it                                                                                                                                                                                   |

The `NOT IN` row is the one to remember: **it is the fastest measurement in the
table and the worst design in it.** A benchmark at one size cannot distinguish
"faster" from "scales differently", and reading the plan is what did.

**The prediction about indexes was wrong, and measuring is what corrected it.**
This section originally said both subqueries would eventually want an index.
`bookings` never needed one. `availability_blocks` needed a _different_ index
from the `(listingId, startAt)` btree it already had — and, critically, needed
the query rewritten before any index could be used at all. An index added on the
original guess would have changed nothing and looked like the question was
settled.

### The target

**The 200 ms figure was agreed on 13 August 2026 for the _undated_ radius query**
at 50,000 listings, and applying it unchanged to a strictly more expensive query
is a decision nobody has taken. At the widest radius the dated search examines
13,203 candidates and performs two index probes on each; that ~130 ms is the
floor for this design, and removing it means either filtering after pagination —
which this ADR exists to refuse — or precomputing availability, which the
alternatives section below rejects for staleness.

**Settled by the product owner on 20 August 2026: the target stays 200 ms, and
the widest dated radius is allowed to miss it for now.** The reasoning given was
that the filter is _wired and correct_, and latency is worked out later. That is
a deliberate deferral rather than a silent one, so it is written down with its
date and its owner.

**What that means concretely.** `measure-search.mjs` still exits non-zero on the
dated 100-mile search, and **that is intended** — the gate number was not widened
to make a red run green. A red line there is the reminder, not a regression.
Nothing else is over: nine of the ten radius-and-origin combinations pass, and
the undated statement is untouched at 134 ms.

**Two conditions worth checking before this stops being deferrable**, because
neither is true today and both change the answer: the platform is not public
(there is no edge, no domain and no rate limiting, so nobody can call this at
volume), and the catalogue is fixture-sized. The cost is
_candidates × two index probes_, so it grows with supply density inside a radius
— **the number gets worse as the marketplace succeeds**, which is the wrong
direction to leave unattended indefinitely.

**The alternative remains available if the coupling ever hurts.** A materialised
view owned by Booking, joined by Search, would restore the boundary at the cost
of staleness — and staleness in an availability filter means showing a listing
somebody has already booked. That trade is worse today; it may not be at scale.

## What was rejected

**A port returning free listing ids.** The filter-after-paginate bug, as above.

**A port returning a SQL fragment.** Keeps the pagination correct and leaks SQL
across a module boundary, which is worse than the read: the fragment's column
names would be Booking's, its placeholders Search's, and neither module could be
read on its own.

**Filtering in the API service after the repository returns.** The same bug one
layer up.
