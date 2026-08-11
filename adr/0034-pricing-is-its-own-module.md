# 0034. Pricing is its own module, though §5.1 does not list one

- **Status:** Accepted — one clause amended by [0042](0042-a-listing-pins-its-questions-not-its-fees.md)
- **Date:** 2026-08-07
- **Relates to:** BRD §5.1, §6.1, §3.4.4, §8.5.2, §14 Phase 2; ADR 0029, ADR 0033, ADR 0042

> **Amendment, 11 August 2026.** The decision below — that pricing is its own
> module with no ports, no store and no routes — stands unchanged. What changed is
> one phrase inside it: the module resolves a listing's rate card against the
> category's **current** fee policy, not against _"its pinned category version's
> fee policy"_ as written here. [ADR 0042](0042-a-listing-pins-its-questions-not-its-fees.md)
> gives the reason: a listing is not a contract and must not carry a price that
> can change when its owner edits the title. A **booking** pins the policy, and
> that pin arrives in Phase 5. The "no ports" argument at the end of this ADR is
> unaffected — both inputs are still in one query.

## Context

BRD §6.1 is binding and unusually specific about where one rule lives:

> Rounding rules are defined once in the **pricing service** and applied
> consistently; rounding is never left to the presentation layer.

BRD §5.1's module table has no pricing module. The nearest owners are
**Catalogue** — "categories, attributes, listings, media, moderation state" —
and **Payments & Ledger**, which owns "authorisations, captures, **fees**,
payouts, refunds, ledger" and belongs to Phase 5.

Slice 2.7b needs the rounding rule now. §3.4.4 requires every price shown on a
search result, a listing card or a listing page to be inclusive of mandatory
fees, and Phase 2 builds the listing page. So something has to compute a price
three phases before the module that §5.1 would give it to exists.

The alternatives are all defensible on their face: a file inside `catalogue/`,
because Catalogue owns listings; a file inside a stub `payments/`, because that
is where §5.1 puts fees; or a helper in `packages/core` beside `Money`.

## Decision

**`apps/api/src/pricing/` opens now, named for the whole concern rather than for
what it holds today.**

It contains the rounding rule and the resolution of a listing's rate card
against its pinned category version's fee policy. It has **no ports, no store
and no routes** — a price is a function of two values the caller already holds.

Phase 4's quote engine (§8.5.2) and Phase 5's fee split land here. `packages/core`
keeps `Money`: the arithmetic primitives are not pricing policy.

## Why

**§6.1 names "the pricing service" as a single place, and a single place has to
be somewhere.** Putting the rule in `catalogue/` would satisfy it for exactly as
long as Catalogue is the only module that prices anything — which is until
Phase 4 opens Booking, at which point either Booking imports from Catalogue's
internals or the rule gets a second copy. Both are the failure §6.1 is written
to prevent.

**Naming the folder for the concern rather than for its contents is a lesson
this project has already paid for once.** Slice 2.5b named its module
`search-location/` rather than `location/`, so that Phase 3's radius query would
inherit the module's existing invariant exemption instead of somebody widening a
rule under deadline. The same instinct applies: a folder called `daily-price/`
or a file called `total-price.ts` would be renamed the moment a quote exists.

**A stub `payments/` would be worse than either.** §5.1 gives that module
authorisations, captures, payouts and the ledger — none of which exist, and all
of which carry provider credentials and idempotency requirements that nothing in
Phase 2 should be near. Creating the folder now would invite the next slice to
put something in it that has not been designed.

**It has no ports deliberately.** Catalogue already reads a listing and its
pinned category version in one query, so both inputs are in hand. Giving this
module its own repository would mean two modules reading the same rows and
potentially disagreeing about which version was pinned — precisely the
disagreement ADR 0029 exists to make impossible.

## Consequences

- **§5.1 and the code now differ, deliberately and in writing.** That is the
  whole reason this ADR exists rather than a comment: an undocumented extra
  module reads as drift to whoever finds it next, and the honest options were to
  amend §5.1 or to record the departure. The BRD is amended only by the product
  owner, so this records it.
- **The boundary rule still holds.** Catalogue calls into `pricing/`; `pricing/`
  imports nothing from Catalogue. It depends on `@platform/contracts` and
  `@platform/core` only, which is what makes it callable from Booking in Phase 4
  without either module importing the other.
- **The price is computed at the projection boundary**, in the controller, not
  in a component. §6.1's second clause — rounding is never left to the
  presentation layer — is enforced by the response carrying a computed
  `inclusiveDailyPrice` rather than the ingredients for one. A component handed
  a rate and a percentage would be a second place a price is worked out, and it
  is also how drip pricing gets built by accident: with the bare rate on the
  response, showing the wrong number is one careless line.
- **Phase 5 will move the fee split here, not into Payments & Ledger.** Payments
  owns moving money; pricing owns deciding how much. When that slice lands, the
  minimum-platform-fee allocation this slice deliberately deferred — which side
  of a booking absorbs the floor — is decided in this module.

## Alternatives rejected

| Option                                 | Why not                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A file inside `catalogue/`             | Satisfies §6.1 until Phase 4 prices a booking, then forces either a cross-module import of internals or a second copy of the rounding rule          |
| A stub `payments/` module              | §5.1 gives it captures, payouts and the ledger — none designed, all carrying credentials nothing in Phase 2 should be near                          |
| A helper in `packages/core`            | `Money` is arithmetic and belongs to every module; a fee policy is domain and belongs to one. Also reachable from the web app, which must not price |
| Compute in the React component         | §6.1 forbids it in terms, and it is how a rate and a fee end up displayed as two numbers instead of one inclusive total (§3.4.4)                    |
| Wait for Phase 5 and inline it for now | "For now" is what produces the second copy. §3.4.4 applies from Phase 2, so the rule is needed now whether or not its home is                       |
