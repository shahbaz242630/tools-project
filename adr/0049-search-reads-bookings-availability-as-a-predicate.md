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

**The performance number is not yet remeasured.** Slice 3.1c's worst p95 was
111.8 ms at 50,001 listings for the undated query, and that number still stands
for the undated query — it is byte-identical. The dated query adds two
`NOT EXISTS` subqueries against tables with no rows to speak of. `measure-search`
can now build the dated statement (`buildQuery` takes `dates` and reads the nine
states out of the state machine rather than copying them), so the measurement is
available; **it has not been run against a loaded database, and the phase handoff
says so.** This is the first search predicate to ship without its own number.

**Two indexes will eventually matter and neither exists.** The subqueries filter
`availability_blocks` and `bookings` by `listingId` and a period. `bookings`
already carries `@@index([listingId, createdAt(sort: Desc)])`, which helps the id
half and not the period half. Deliberately not added now: an index chosen without
a measurement is a guess, and both tables are small enough that the guess would
be unfalsifiable.

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
