# 0044. The radius query crosses two boundaries, and only these two

- **Status:** Accepted
- **Date:** 2026-08-13
- **Relates to:** BRD §4.2, §5.1, §8.4.1, §14 Phase 3; ADR 0004, ADR 0032, ADR 0035, ADR 0041, ADR 0043
- **Slice:** 3.1a

## Context

ADR 0032 settled what the radius filter runs against — the fuzzed point, not the
true one, and it made that binding on this phase. It did not settle **where the
query lives or what it is allowed to touch**, and that turns out to be the harder
question, because three rules this project holds firmly all pull in different
directions the moment a search exists.

- **BRD §4.2**, repeated in CLAUDE.md: _"raw SQL for radius queries, confined to
  the Search & Location module behind a repository interface."_ Prisma cannot
  express PostGIS, so the query is raw SQL and it lives in that module.
- **BRD §5.1**: modules talk through application services, interfaces or domain
  events. Catalogue owns `listings`.
- **BRD §8.4.1**: a public read must not reach a listing's street lines. Until
  now that has been guaranteed **structurally** rather than carefully —
  `findPublished` does not join `listing_locations` at all, and the phrase the
  handoff uses for it is that _a join that was never written cannot be
  forgotten_.

Add to those the three authorities that decide whether a listing is publicly
visible (ADR 0041, ADR 0043): the owner's `status` and the platform's
`moderationState`, both on `listings`, and the owner's `ownerStatus`, which is on
`profiles` and belongs to Profiles.

The conflict is concrete rather than theoretical. A geo query that filters
nothing returns mostly drafts — seven of the eight local fixtures are drafts, and
the ratio will not improve. A geo query that filters everything reads three
tables across two other modules. A geo query that reads nothing but its own table
cannot filter at all, so its page of twenty-four results arrives as two.

Something has to give, and this ADR records exactly what — because both
concessions look like mistakes to somebody reading the code later, and one of
them genuinely weakens a guarantee that has been load-bearing since 2.5a.

## Decision

### The port takes a postcode and returns ordered ids with a bucket

Catalogue declares `ListingProximity`; Search & Location answers it. That is the
direction `ListingLocator` and `OwnerStatusSource` already run — the consumer
states what it needs and does not import the module that provides it.

```
findWithin(originPostcode, radiusMiles, limit) → { matches, truncated } | null
matches: { listingId, distance: DistanceBucket }[]   // nearest first
```

Three things about that signature are the decision rather than a style choice.

**It takes a postcode, not a coordinate.** Geocoding the searcher's origin
happens inside Search & Location, so no bare coordinate ever crosses the
boundary. `LocationService.geocode` is private precisely because _"a caller that
could ask for just the coordinates is a caller that will eventually store them
somewhere public"_, and the obvious implementation — Catalogue geocodes the
origin, then passes a point in — would have required widening it. This keeps that
sentence true, and it also keeps the geo maths whole: miles-to-metres happens
where the earth radius is already a constant.

**It returns a bucket, not a distance.** §8.4.1 requires displayed distances to
be coarse, and a port handing back metres is a port whose caller has to remember
to round. Bucketing inside the module means the trilateration defence is complete
in one place, and it means no exact figure — even a fuzzed one — exists above the
repository to be logged, cached or serialised by accident. The cost is that
Catalogue cannot re-sort the results, which is why the port promises an order.

**It returns ids, not listings.** Search & Location never reads a title, a price,
a rate card or an address. The projection stays Catalogue's, where §8.4.1's
guarantees already live, and hydration is a second query against
`findPublishedSummaries(ids)` which re-applies the visibility predicate. Two
round trips instead of one is the price of the boundary, and it is a price worth
paying — the alternative is a second place in the system that knows how to
assemble a public listing.

### First boundary: Search reads two of Catalogue's columns

The SQL joins `listings` for `status` and `moderationState`, and for nothing
else.

This is a cross-module read and BRD §5.1 does not love it. It is accepted because
the alternatives are all worse in ways that are easy to demonstrate:

- **Filtering after the geo query** is the classic filter-after-paginate bug.
  Ask for twenty-four rows, discard the drafts, show four — and the truncation
  flag becomes a lie, because "more exist" and "more visible ones exist" stop
  being the same question.
- **Denormalising visibility onto `listing_locations`** would give the rule a
  second home, which is exactly what ADR 0041 spent a slice avoiding, and it
  would need a trigger keeping two tables agreeing about the thing that decides
  whether a stranger sees somebody's property.
- **Putting the whole query in Catalogue** contradicts §4.2 and would put PostGIS
  and raw SQL in the module that owns every write in this phase.

Two enum columns, read as a predicate, never projected. It is the narrowest form
of the crossing available, and BRD §4.2 already sites the query in this module,
so this is the normative mechanism carrying its own cost rather than a
deviation from it.

### The third authority is applied on hydration, and the asymmetry is deliberate

`ownerStatus` lives in Profiles and is **not** in the SQL. Catalogue applies it
after hydration, through the port it already has, exactly as `findPublic` does.

The reason the two visibility checks are treated differently is that they exclude
different amounts. `status` and `moderationState` exclude nearly everything — a
draft is the normal state of a listing. `ownerStatus` excludes almost nothing,
because publication already refuses an owner who has not declared or who has
declared business; the only rows it removes are listings whose owner changed
their declaration _after_ publishing, which is the narrow case ADR 0043 built the
live re-check for.

So the trade is: reading a third table owned by a third module, on every search,
to avoid an occasionally short page. The short page wins. **This is a real if
small defect and it is accepted with its name written down** — a page can come
back with twenty-three results where it promised twenty-four. If it ever matters,
the fix is a domain event denormalising the flag onto `listings`, and that is a
slice, not a patch.

### Second boundary: the public search must join the private table

`fuzzedPoint` lives on `listing_locations`, and so do the encrypted street lines.
The radius query therefore has to join the one table every public read has so far
been careful never to touch.

**This is the concession that costs something real.** Since 2.5a the promise has
been structural: the public read cannot leak a street line because it does not
join the table holding one. From this slice the promise becomes _the select is
narrow_ — and the handoff is right that a select can be forgotten where a missing
join cannot.

It is unavoidable at this schema. The alternative is moving the fuzzed pair and
its geography column onto `listings`, which 2.5b considered and rejected in the
schema itself: it would put a raw-SQL-only concern on the central model of the
phase, and `Unsupported` columns constrain what Prisma can write. Reopening that
would be a migration moving three columns to buy back a guarantee that three
compensating controls can hold instead.

The compensating controls, all in this slice:

1. **The repository returns ids and a bucket.** There is no field on its result
   type that a street line could occupy, so the narrow select is enforced by the
   type rather than by care.
2. **A database test serialises the whole search response and greps it** for the
   fixture's street line, its full postcode and both true coordinates — the
   method 2.10 was verified by, applied to a collection.
3. **`no-raw-sql-outside-search` is tightened in the same slice.** Its exemption
   is `p.includes('search')`, which passes any file anywhere with "search" in its
   name. That has cost nothing while no raw SQL existed. It is scoped to the
   module directory now, before the first raw SQL in the project's history goes
   in behind it.

## Consequences

**Search & Location is no longer a leaf.** It reads a table it does not own, so a
change to `listings.status` or `moderationState` — the vocabulary, not the values
— now has a second reader that a migration author will not find by grepping
Catalogue. The predicate is a named constant for that reason.

**The "join that was never written" guarantee is spent.** It protected the public
listing page and it still does; it no longer protects every public read, because
this one had to write the join. Anybody adding a field to the search result must
now check what the query can see, which was previously not a question worth
asking.

**A search page can be short by a row or two**, silently, when an owner has
flipped their declaration since publishing. Named above, accepted, and the fix is
known.

**Nothing here changes what is stored or what is public.** No migration, no new
column, no coordinate on the wire. The true point stays where ADR 0032 put it,
and this slice adds no way to reach it.

## Alternatives rejected

**Hand the port a coordinate instead of a postcode.** Rejected: it requires
making `LocationService.geocode` public, and the docblock explaining why it is
private predicts exactly what happens next.

**Return metres and bucket at the controller.** Rejected: it puts a §8.4.1
control in the layer whose job is serialisation, and leaves an exact distance
above the repository for the first log line or cache key to pick up.

**Return whole listings from the geo query, in one statement.** Fastest, and it
gives Search & Location a second implementation of the public projection. The
first divergence between the two would be a field visible in search results and
not on the listing page, or the reverse — and the version of that bug which
matters is the one where search is the more generous of the two.

**Move `fuzzedLatitude`, `fuzzedLongitude` and `fuzzedPoint` onto `listings`** so
the public search never joins the private table. Genuinely tempting, and it is
the only option that keeps the structural guarantee intact. Rejected for now: it
contradicts a decision recorded in the schema fifteen slices ago, it puts an
`Unsupported` column on the model every write in this phase touches, and the
guarantee it buys back can be held by a type, a test and a tightened invariant.
**Worth reopening if a second public read ever needs the geo column** — at two
readers the balance changes.

**Denormalise all three visibility authorities onto `listing_locations`.**
Rejected: a second home for the rule ADR 0041 deliberately gave one home, kept in
step by a trigger, deciding whether strangers can see somebody's property.
