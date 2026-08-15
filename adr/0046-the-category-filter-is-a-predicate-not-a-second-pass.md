# 0046. The category filter is a predicate, and an absent one is absent

- **Status:** Accepted
- **Date:** 2026-08-15
- **Relates to:** BRD §8.2, §8.4, §8.4.1, §8.17, §10.1, §14 Phase 3, §15; ADR 0027, ADR 0032, ADR 0035, ADR 0044, ADR 0045
- **Slice:** 3.2a

## Context

BRD §14 Phase 3 asks for _"date and category filters"_. Only the category half is
buildable: there is no `Booking` model, no availability model, and `listings`
carries no date but `createdAt`, `updatedAt` and `moderatedAt`. _"Availability
calendar and blocked dates"_ is Phase 4's first line item, so a date filter here
would either drag that calendar forward or ship a control that filters on
nothing. This ADR covers the category filter; the date filter's deferral is a
BRD amendment, recorded in the master handoff.

Three things about the category made the shape non-obvious.

**A category is configuration, not a fixed vocabulary.** Every other search
parameter is a closed union the compiler holds — five radii, twenty pages, four
outcomes. Categories arrive through an audited administrative form with no
deploy, so anything that scales with their number scales with a decision nobody
building this will see.

**The predicate has to live in Search & Location, which does not own the
column.** ADR 0044 already conceded that the geo query reads `listings.status`
and `listings.moderationState` as a predicate, for the reason it records:
filtering afterwards is the filter-after-paginate bug — ask for twenty-four rows,
discard most of them, and show four under a truncation flag that has stopped
meaning anything. A category filter has exactly that shape, and drafts are not
even needed to demonstrate it.

**The filter is optional, and the unfiltered query is the one the Phase 3 exit
gate was measured against.** Slice 3.1c recorded a worst p95 against a 200 ms
target, and found the cost dominated by the per-row primary-key lookup into
`listings` rather than by the geometry. A gate number that no longer describes
the statement that ships is worse than no number.

## Decision

**The category is filtered inside the radius query, as one more equality
predicate on `listings`** — a third column of Catalogue's table read by Search &
Location, never projected. ADR 0044's concession, extended by the narrowest step
available.

**Catalogue resolves the slug; Search & Location receives an id.** The port takes
`categoryId: string | null`, so the search module never joins `categories` and
never learns that slugs exist. Resolution is a dedicated `findCategoryId` on
`CategoryOptionSource` rather than a reuse of `findOption`, which would read the
attribute schema and the transport options on the hottest public read to answer a
question a unique index answers.

**A slug naming no category is a 400, not an empty page.** The same treatment as
a radius of seven and a page past the cap: a URL claiming something we do not
serve is told so. Serving an empty page would tell somebody there is nothing near
them in a category we have never had — indistinguishable from a quiet area, and
counted as one by the §17 zero-result metric.

**An absent filter composes to nothing at all.** The statement is assembled with
a `Prisma.empty` fragment when no category was chosen, so the unfiltered query is
**byte-identical to the one slice 3.1c measured**.

**The ports take a request object rather than positional arguments.**
`originPostcode` and `categoryId` are both strings; a signature carrying them
side by side type checks with them swapped and returns a plausible empty page
rather than an error. The same reasoning moved the URL builders — five functions
across the contract and the web app — to take `ListingSearchQuery` whole.

**The metric records _whether_ a search was filtered, never _which_ category.**
`listing_searches_total` gains a boolean `filtered` label, taking it from twenty
series to forty.

## Consequences

**Search & Location now reads three of Catalogue's columns rather than two.** A
change to the category table's identity has a reader that grepping Catalogue will
not find. The id is typed as a plain string, so the compiler cannot help here the
way it does for `status` and `moderationState`, which are typed against the
contract's vocabularies.

**The radius query is now composed rather than fixed**, which is a new class of
mistake in the one file holding hand-written SQL: a fragment is a place a
predicate can be forgotten or duplicated. Mitigated by the id remaining a _bound
parameter_ inside the fragment — this is not string-building SQL — and by db
tests that break the predicate and watch four tests fail.

**Two statements now exist where there was one**, so the plan cache holds two and
`measure-search.mjs` had to learn a substitution that is a whole predicate rather
than a scalar. In exchange, 3.1c's numbers still describe the unfiltered query
exactly, and the filtered one was measured beside it rather than assumed:
**p95 99.6 ms filtered against 98.1 ms unfiltered** at 50,000 listings, London at
100 miles, with **40,663 buffer hits in both plans** — the predicate rides the
primary-key lookup that was already happening and costs nothing measurable. No
index was added.

**The measurement's worst case is a filter that excludes nothing**, because the
load generator puts every seeded listing in one category. A selective filter can
only be cheaper, so this is the right bound — but it means the _selective_ case
is inferred rather than measured.

**Forty metric series instead of twenty**, paid deliberately. The next label
doubles it again, which is why the number is asserted in a test rather than
described.

**A 400 for an unknown category is a status this endpoint did not previously
return for a well-formed request**, and the same error class is a 404 on the
write path. The difference is decided in the controllers, where the caller is
known, and both say so.

## Alternatives considered

**Filter after the geo query, in Catalogue, where the owner declaration is
already applied.** Rejected: ADR 0044 named this as the filter-after-paginate
bug and accepted a boundary crossing specifically to avoid it. The owner
declaration is applied there because it excludes almost nothing and lives in
another module's table; a category filter is the opposite on both counts.

**Write the predicate inline as `($1 IS NULL OR "categoryId" = $1)`.** One
statement, always the same text, no composition. Rejected: a dead predicate is
evaluated on every candidate row of **every** search, so it changes the plan of
the unfiltered query — the one the exit gate was measured against, and the one
almost every search will be. Paying a permanent cost on the common path to avoid
composing on the rare one is the wrong way round.

**Pass the slug to Search & Location and join `categories`.** Rejected: it gives
the search module knowledge of a Catalogue concept and adds a join to the query
that already had to spend §8.4.1's "join that was never written" guarantee.

**Put the category id on `CategoryOptionRecord` so `findOption` could serve
both.** Rejected: that port's docblock says it returns _"what an owner needs to
pick a category and fill in its fields, and nothing else"_, and widening it hands
an internal identifier to every consumer to save one method.

**Answer an unknown slug with an unfiltered search.** Rejected outright: it shows
somebody every category while their address bar names one.

**Answer an unknown slug with an empty page.** Rejected: it is a lie about
supply, and §17's zero-result rate would record it as one.

**Label the metric with the category slug.** Rejected: unbounded cardinality
driven by configuration, held in process memory and exported to a scraper with
none of §10.1's retention or erasure rules. The question worth asking —
_is filtering what emptied the page?_ — is answered by a boolean.

**Add an index on `listings."categoryId"`.** Rejected on evidence rather than
taste, which is 3.1c's rule: the plans are identical and the buffer counts are
equal, so there is nothing to speed up.

## What would change this

**A second filter that is not a column of `listings`.** Price is; rating and
availability are not, and the first of those turns this from "one more predicate"
into a query with joins Search & Location has no business owning. At that point
ADR 0044's rejected option — moving the fuzzed geometry onto `listings` so the
public search never joins the private table — becomes the better shape, and its
own note says to reopen it at two readers.

**A catalogue large enough that filtering is selective and common.** The
measurement here bounds the worst case; if most searches carry a category and
most categories are small, an index on `(categoryId)` or a composite with the
visibility columns may earn its place. Measure before adding it — 3.1c's finding
was that the geometry is not what costs.

**Buying a filter that a searcher can express as more than one value.** "Any of
these three categories" is an `IN`, not an equality, and it changes both the
predicate and the closed-vocabulary argument for the `filtered` label.
