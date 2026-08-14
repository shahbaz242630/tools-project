# 0045. Search pages by number, not by cursor

- **Status:** Accepted
- **Date:** 2026-08-14
- **Relates to:** BRD §3.4.4, §8.4, §8.4.1, §8.17, §10.2, §14 Phase 3, §15; ADR 0032, ADR 0035, ADR 0044
- **Slice:** 3.1d

## Context

Slice 3.1a bounded a search at twenty-four results and said so with a `truncated`
flag; slice 3.1b rendered that as a sentence apologising for it. Nothing could
reach result twenty-five. This ADR records how the rest became reachable, because
the answer is the one that looks naive from the outside.

**`OFFSET` has a bad name, and mostly deservedly.** It is O(n) in the depth
requested — the database finds every row up to the offset and throws them away —
so the standard advice for an ordered feed is a **keyset cursor**: carry the last
row's sort key in the URL and ask for rows beyond it. That advice is right for a
feed of millions with an ordering the client may hold.

Two things make it the wrong advice here, and the first is the one that would
otherwise have decided it by default rather than by argument.

**The sort key is a distance.** Search is ordered by how far each listing is from
an origin the searcher chose, so a keyset cursor would carry an exact distance —
`?after=3812.44,<id>` — as the price of entry.

**The phase handoff originally said that reintroduced "the precision §8.4.1 exists
to remove", and that was overstated.** The correction matters because it changes
which argument is doing the work. The distance is measured from the **fuzzed**
point (ADR 0032), which is a location we publish deliberately; recovering it
perfectly still leaves the true address somewhere in an annulus of roughly
2.4 km². So a cursor is **not** a §8.4.1 breach. What it is, is an exposure
widening: a URL is copied into browser history, referrer headers, access logs,
analytics and shared links, so it moves "derivable by a determined prober" to
"sitting in plaintext in a dozen places we do not control". Worth avoiding on its
own terms, not worth pretending it is a breach.

**And the performance argument was measured rather than assumed.** Slice 3.1c put
the widest search over 50,001 listings at a **p95 of 111.8 ms** against a 200 ms
target, and found that what dominates is the per-row primary-key lookup into
`listings` for the visibility predicate — 52,633 of 54,359 buffer hits — not the
geometry and not the ordering. The skip is not what this query spends its time
on.

## Decision

### Pages are numbered, one-based, and the number is capped

`GET /public/listings` takes `page`, an integer from 1 to `MAX_SEARCH_PAGE` (20),
defaulting to 1. The server multiplies by its own page size to get an offset.

**A page number rather than an offset parameter**, so a caller cannot ask to skip
an arbitrary number of rows, and cannot read the page size out of a URL. It is
also the shape §8.17's canonical URLs will want in slice 2.12, and the shape a
person can read.

**The cap is an availability control, not a product limit.** Uncapped,
`?page=100000` is a 2.4-million-row skip on what
`public-listing-search.controller.ts` already calls the most exposed thing in the
system: a collection, from a caller-chosen origin, with no rate limiting anywhere
in front of it (`SECURITY.md`, BRD §10.2). Twenty pages is 480 results, past any
depth a person browsing tools near them reaches — and somebody who genuinely
needs more of a dense area wants a narrower radius or the filters still to come.

**A page beyond the cap is refused rather than clamped**, exactly as a radius of 7
is refused: a URL claiming something we do not serve is told so rather than
quietly answered with something else.

### The first page carries no `page` parameter

`?page=1` and the bare URL return identical results, so minting both would create
the duplicate-content problem slice 2.12 has to answer for §8.17. Cheapest not to
create it. It also means this slice changed no URL that already existed.

Page 2 onwards is served `noindex, follow`. That is the conservative default and
**not** the answer to §8.17's canonical question, which remains 2.12's.

### The control navigates; it does not append

The design package specified a _"Show more"_ button — 24 per page, appended in
place, which means JavaScript. Slice 3.1b deliberately built Browse as a plain GET
form with no JavaScript at all, which is what makes a search shareable, the back
button work, and the page usable before hydration and by a crawler.

That is kept, so the control **replaces** the grid rather than adding to it, and
**the label changes to match**: `Next 24 tools` and `Previous 24 tools`. A control
labelled "Show more" that in fact replaces what is on screen is a small lie, and
BRD §15's rule that a control must do what it says has no size exemption. This is
a deliberate departure from the design package, pinned by a test, in the same way
`DESIGN.md` records D3's.

### The window crosses the port as one object

`ListingProximity.findWithin` takes `{ limit, offset }` rather than two numbers.
`(…, 24, 24)` type checks with the arguments the wrong way round and means
something entirely different; the compiler cannot tell two numbers apart and can
tell two fields apart.

The **page number never crosses the port**. The service converts it, because that
is the only layer that knows both how large a page is and which page was asked
for.

## Consequences

**The `ORDER BY` tiebreak stops being cosmetic.** `ORDER BY "metres" ASC, l."id"
ASC` went in during 3.1a to stop the displayed order wobbling between requests.
Under `OFFSET` an unstable total order means a row served on page one is served
again on page two, or by neither — silently, with both pages looking correct.
`prisma-listing-search.db.test.ts` walks two pages of listings at an _identical_
published point for exactly this reason, and the adapter says not to remove the
tiebreak as redundant.

**That test is weaker than it looks, and the weakness is recorded rather than
glossed.** It was checked the way 3.1a checked the trilateration tests — by
breaking the query and re-running — and **it still passed with the tiebreak
removed**, twice, including with a row rewritten between the two page reads to
shift it in the heap. Four rows is small enough that Postgres is deterministic,
and no fixture that file can build is not. So the test guards the gross failure
(a lost `ORDER BY`, offset arithmetic that repeats a row) and not the tie itself.
The tiebreak stays on the strength of the documented guarantee — Postgres
promises nothing about tied rows, and the case that breaks it is a plan change at
a scale no test here reaches. **That is an argument from the manual rather than
from evidence, and it is the one claim in this ADR that is not measured.**

**Live data still makes paging approximate, and this is not solved.** A listing
that is published, paused or moderated between two page loads can be seen twice
or missed. That is inherent to offset pagination over a changing set; a cursor
would narrow it, not remove it. Not worth a correctness mechanism for a
marketplace of this size.

**ADR 0044's short-page cost is unchanged, not worsened.** `truncated` comes from
the proximity query, so a listing dropped afterwards by its owner's declaration
still shortens a page without moving the flag. It now does so per page rather
than once.

**The N+1 on owner status stays bounded per request.** This is why cumulative
paging — `?show=48`, which would have kept the design's "Show more" label honest
without JavaScript — was rejected: 96 rows can be 96 distinct owners and
therefore 96 queries, which would quietly make 3.1a's deferred N+1 worse. Fixed
pages hold it at 24.

**The measurement measures the deep page now.** `measure-search.mjs` times the
last permitted page beside the first, so this ADR's central claim is a number
somebody can reproduce rather than an inference. Slice 3.1c's lesson was that a
performance claim nobody measures is one that is wrong in a way that looks fine.

**Two comments that predicted a cursor were inverted rather than deleted.**
`limits.ts` said in two places that `ListingStore.listOwnedBy` was waiting for a
cursor "once a third caller wants a third answer", and that search was it. Both
are corrected: the cursor is not arriving, the slice number was wrong (3.1b,
not 3.1d), and `listOwnedBy`'s own docblock never mentioned a cursor at all — it
requires an explicit bound, which it has.

## Alternatives rejected

**A keyset cursor on `(distance, id)`.** The performant answer, and the wrong
trade here: it puts an exact distance from a chosen origin into browser history,
logs and shared links, in exchange for solving a cost 3.1c measured at 111.8 ms
worst case and which is dominated by something else entirely. Revisit if the
catalogue grows two orders of magnitude, at which point the fix ADR 0044 already
names — denormalising visibility onto `listings` — is the first thing to do
anyway.

**Cumulative pages (`?show=48`).** Would have made "Show more" literally true
without JavaScript. Rejected for the owner-status N+1 above, and because an
ever-growing bound is the shape ADR 0035 exists to refuse.

**An `offset` parameter instead of `page`.** Lets a caller skip an arbitrary
number of rows, leaks the page size, and is worse for §8.17's canonicals.

**Infinite scroll.** Needs JavaScript, has no shareable URL, is hostile to
crawlers, and is a well-documented accessibility problem for keyboard users
trying to reach a footer.
