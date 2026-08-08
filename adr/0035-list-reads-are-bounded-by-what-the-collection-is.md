# 0035. List reads are bounded, and the bound is chosen by what the collection is

- **Status:** Accepted
- **Date:** 2026-08-08
- **Relates to:** BRD §10.1, §10.2, §14 Phase 2; ADR 0019, ADR 0025

## Context

Slice H2 set out to add a `take` to three unbounded `findMany` calls. Reading
them showed they were not one problem.

`ListingStore.listOwnedBy` reads a collection **users create**. Nothing stops an
owner writing listings all day, and its only caller was the data export — so the
query grew without our permission on the most expensive endpoint we serve.

`CategoryStore.list` and `CategoryOptionSource.listOptions` read a collection
**an administrator creates**. Rows arrive only through an audited form. The
launch catalogue is one category; `reference-category-taxonomy.md` found that HSS
Hire runs thousands of products across a few dozen groupings, so a mature version
of this platform is tens.

The obvious fix — a `take` on each — is wrong on both, in opposite directions.

On the export, a bare `take` silently truncates a UK GDPR Article 15 response.
BRD §10.1 requires that answer to be complete, so a bound with nothing beside it
would replace a memory problem with a legal one, and neither the reader nor we
would be able to tell a short export from a whole one.

On the two category reads, the temptation is the opposite: to add pagination for
consistency. A paginated picker over a list of two categories is a control that
does nothing, and this project does not ship dead controls. But leaving them
unbounded because they are "naturally small" is not a bound at all — it is a
property of today's data, which is exactly what stops being true without anybody
noticing.

There was already a precedent for the honest version. Slice 1.11a bounded the
sign-in history at `EXPORTED_SIGN_IN_LIMIT` and put `signInsTruncated` in the
document beside it, fetching one row more than it served so that "there were
more" was measured rather than inferred from a full page.

## Decision

**Every list read is bounded, and the bound is chosen by what the collection is.**

- A collection **users create** is bounded as a page size, and wherever the cut
  is visible to a person it is **declared to them**. The export's listings
  section carries `listingsTruncated`, exactly as `signIns` carries its own flag,
  and the export document goes to schema version 4.
- A collection **an administrator creates** is bounded as a **guardrail**: a
  ceiling set orders of magnitude above any plausible value, which normal use
  never reaches. It gets no pagination and no page control. Reaching it is an
  operational event, so it is **logged as a warning** rather than shown on screen.

**No bound is silent.** Whichever kind it is, something has to be able to tell a
truncated answer from a complete one.

**The `limit + 1` probe is the mechanism**, shared rather than open-coded:
`Paging.probe(n)` asks for one more row than will be served and `Paging.fitTo`
trims it and reports what it dropped. A result whose length equals the limit is
otherwise indistinguishable from a complete list that happens to be that long.

**`Paging` lives in `@platform/core`**, beside `Scaled`. The clamp it also holds
had already been written twice — `bound` in `audit.service.ts` and
`boundedSignInLimit` in `identity.service.ts` — and the two disagreed: one
guarded against a non-finite request and the other did not, so `NaN` survived
every clamp and would have reached Prisma as `take: NaN`. H2 was about to write a
third copy. The project's own rule from slice 2.7b is that the third occurrence
of a fix means the rule is missing rather than the patch.

## Consequences

The three reads are bounded and their bounds are provable. **They are provable
only in a db test**, and that is the part worth stating: `Paging.fitTo` trims
whatever it is handed, so a service that read every row and sliced afterwards
behaves identically to one whose query was bounded — same list, same flag. The
difference lives entirely in what Postgres was asked for. This was found by
removing `take` from the adapters and watching the service tests stay green while
the db tests failed.

The export document is at **schema version 4**. A required field added to it
means yesterday's file no longer parses, which is what that constant is for.

**`CatalogueService` and `ListingsService` now take a `Logger`**, for one purpose
each: reporting a guardrail firing. Nothing on the ordinary path logs, because a
service that logs every call produces a log nobody reads.

**Two limits are shared between the admin list and the owner's picker.** They
read the same table, and the failure a drifting pair produces is the worst one
available here — a category an administrator can see and configure but no owner
can list an item in.

**We accept that a catalogue over 500 categories is served incompletely** until
somebody acts on the warning. That is a deliberate trade: serving most of the
catalogue beats serving none of it, and refusing the request would take the admin
page down over a condition that means a bug elsewhere.

**Slice 2.9's owner dashboard will need a real page**, not this bound. It shows a
person their own listings and will want a cursor and a control. `listOwnedBy`
takes a required limit precisely so that slice has to decide what it wants rather
than inherit the export's answer.

## Alternatives considered

**A bare `take` on all three.** Rejected on the export: it answers a
subject-access request with a partial file that reads exactly like a complete
one, which §10.1 does not permit and no reader could detect.

**Batched iteration on the export, to stay complete without a bound.** This was
the first design, and it was abandoned once slice 1.11a's precedent was found. It
would have made the export unbounded again in everything but memory — an owner
with fifty thousand listings would still assemble fifty thousand rows into one
synchronous response — and it would have been a second, different answer to a
question this codebase had already answered.

**Full pagination on the category reads.** Rejected as a dead control. It would
add a cursor, a page parameter, response fields and a UI affordance, all for a
list that has one row in it, and the first person to meet it would be an
administrator wondering what the button was for.

**An optional `limit` with a default.** Rejected. An optional bound is one a
caller omits, and the omission is invisible until the table is large — which is
precisely how `listOwnedBy` spent five slices reading every listing an owner had
ever written without anybody noticing.

**A warning threshold below the cap**, so the log fires before truncation
starts. Deferred rather than rejected. It is strictly better and it is more
moving parts than H2 needs; the cap is far enough above reality that the first
warning will be a bug report either way.

## What would change this

**A category read that stops being administratively bounded.** If categories ever
arrive from a bulk import, a partner feed or user submission, the guardrail
reasoning collapses and those two reads need real pagination — the population
would no longer be a decision somebody made.

**A second consumer of `listOwnedBy` that renders a page.** Slice 2.9 is that
consumer. When it lands, this ADR governs the export's bound and 2.9 chooses its
own; if a third caller appears wanting a third answer, the port should take a
cursor rather than accumulate limits.

**Any of these bounds being reached in normal operation.** That is the signal the
bound was a page size wearing the wrong name, and the read needs pagination
rather than a bigger number.
