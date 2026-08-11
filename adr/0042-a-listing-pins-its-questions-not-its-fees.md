# 0042. Pin a listing's questions, not its fees, and re-pin by editing rather than by asking

- **Status:** Accepted
- **Date:** 2026-08-11
- **Relates to:** BRD §3.4.4, §8.2, §8.3, §6.2, §14 Phase 2; ADR 0027, ADR 0029, ADR 0033, ADR 0034
- **Supersedes:** the deferred question in [0029](0029-attribute-values-are-read-against-the-pinned-version.md) ("What would change this"), and the phrase _"against its pinned category version's fee policy"_ in [0034](0034-pricing-is-its-own-module.md). Both remain accepted in every other respect.

## Context

ADR 0029 settled that a listing's attribute values are read against the category
version it pinned, and deliberately left one question open, naming the slice that
had to answer it:

> If listing **editing** arrives and an owner needs their listing moved to the
> current configuration, that is a re-pin, and it needs its own decision about
> what happens to values under keys the new schema lacks.

That slice was planned as **2.8d**, as an explicit, value-migrating operation an
owner performs. Between 0029 and now, slice 2.7a put the **fee policy** on the
same `category_versions` row as the attribute schema. Re-pinning therefore
stopped being a question about form fields and became one about money: moving a
listing to a newer version changes what the renter pays and what the owner keeps.

Designing that operation produced five open questions — what happens to answers
under dropped keys, what happens to newly-required attributes, whether the fee
change is shown before confirming, whether a published listing may be re-pinned
in place, and whether the act is audited. Two were escalated to the product
owner, who asked for research rather than a decision.

**The research found that no consumer marketplace has this operation at all.**

- **eBay versions its categories exactly as we do** and publishes an old-to-new
  mapping when they change (`GetCategoryMappings`, `CategoryVersion`). It never
  asks a seller anything. Listings are remapped, and the seller meets the change
  only when they next revise or relist — at which point the form carries the
  current required item specifics and publication is refused without them.
  Live listings keep running untouched.
- **Fee changes are platform-wide and dated, never per-listing.** Airbnb's 2025
  host-fee change was announced once and applied to everyone on a set date.
- **The UK Platform-to-Business Regulation requires 15 days' written notice**
  before changing terms for business users, and a fee change is a terms change.
  That makes a fee change an announcement with a date on it. A per-listing
  consent button would not discharge the obligation, and would imply the fee is
  negotiable per listing when it is not.
- **Permanently parallel fee rates are a known operational trap.** Where
  platforms grandfather old rates at all it is time-boxed, typically six months.

The product owner's stated goal is the plainest possible flow: list an item,
price it, add photographs, go live. A screen asking an owner whether to move
their lawnmower onto version 4 of a configuration they have never heard of does
not survive contact with that sentence.

## Decision

**A listing pins the version that gives its stored answers meaning, and nothing
else.**

1. **Attribute values stay pinned**, exactly as ADR 0029 requires. A stored `25`
   is unreadable without the definition saying kilograms at one decimal place,
   and that definition must not move underneath it.

2. **The fee policy is read from the category's _current_ version, never from the
   listing's pinned one.** A listing is not a contract; a booking is. The price a
   listing displays is therefore always the price payable today, which is what
   §3.4.4 requires of a listing card in the first place.

3. **A booking pins the fee policy at the moment it is made.** That is what §8.2
   means by a booking retaining the terms it was made under, and it is the only
   pin the ledger needs. Phase 5 owns it.

4. **Re-pinning happens by editing, and is not a separate operation.** When an
   owner edits a listing, it comes onto the current version — because the form
   they are looking at _is_ the current version. Nothing is silent: the current
   questions are on screen, and the publication gate already refuses a listing
   that has not answered the required ones.

5. **Nothing re-pins a listing nobody touched.** No background job, no migration,
   no side effect of publishing. A listing left alone keeps its version
   indefinitely, and stays publishable under it.

6. **Slice 2.8d is deleted rather than deferred**, and the five questions with it.

`feePolicy` **stays on `category_versions`** and is not moved. The version row is
immutable, so the history of what the platform charged and from when is preserved
and provable — which a mutable current-rate column would destroy. What changes is
only which row the _listing_ reads: the latest, not its own.

## Consequences

**Editing a listing can no longer change what its owner earns**, which is what
made the operation frightening and is the whole reason for point 2. This is the
consequence the decision exists to produce.

**A fee change now takes effect for every listing at once, with no per-listing
step** — including listings whose owners never open the site again. That is
correct commercially and is what the P2B notice period governs, but it means
**the platform now owes a notice mechanism it does not have.** Changing a fee
policy today updates every displayed price immediately and tells nobody. That is
acceptable while the launch category has no live listings and no business sellers,
and it is a real obligation the moment either exists. It belongs with the
notification channel in Phase 6, and it is recorded as a gap rather than solved
here.

**Two listings in one category can still be under different attribute
vocabularies indefinitely** — ADR 0029's consequence, unchanged, and the reason
anything aggregating across a category must read each listing's own pinned
schema.

**A listing nobody edits never comes onto new configuration.** An attribute made
required last month does not apply to a listing written before it, and will not
until its owner next saves. eBay accepts precisely this, and the alternative — a
sweep that re-pins everything — is the silent migration ADR 0029 rejected.

**Slice 2.7b's read path and `ListingRecord.categoryFeePolicy` change**, and so
does the docblock in `listing-store.ts` that explains why the pinned policy
travels with the listing. That comment is currently correct and will become
wrong; it is called out here because it argues the opposite case fluently and
would otherwise be read as the rule.

**The two-part answer is harder to explain than one pin.** "The listing remembers
its questions but not its prices" needs a sentence, where "the listing remembers
everything" needs none. The compensation is that the awkwardness is confined to
one docblock, rather than surfacing as a screen every owner has to understand.

## Alternatives considered

**Build 2.8d as specified — an explicit, owner-facing re-pin.** The plan of
record, and it loses on evidence rather than on taste: no comparable marketplace
exposes this, it puts a versioning concept in front of people who do not have one,
and its own design generated five questions of which two were unanswerable without
knowing what other platforms do. It also cannot discharge the P2B notice
obligation while appearing to.

**Re-pin on edit, keeping fees pinned too.** The smallest change, and the one that
keeps the current model intact. Rejected because it makes editing a title change
what somebody is paid — a money consequence attached to an unrelated action, with
no screen where it could honestly be disclosed. Every attempt to make it safe
turns back into 2.8d.

**Never re-pin at all; validate edits against the pinned schema.** Defensible,
and it is what the system does today by having no edit path. Rejected because a
category's configuration would then apply only to listings created after it, so an
administrator fixing a bad attribute could never reach the listings that have it,
and the owner would be editing a form whose labels no longer match the site.

**Move `feePolicy` off `category_versions` onto a current-rate column.** Simpler
to read — one place, always current. Rejected because it destroys the record of
what the platform charged and from when. That history is needed to explain a past
payout, and from Phase 5 it is what a booking's pinned rate is checked against.
Immutability is cheap here and the loss is permanent.

**Grandfather existing listings on their old fee rate, time-boxed.** What some
platforms do, and it is a commercial decision rather than an architectural one.
Rejected for now on cost: it requires exactly the per-listing fee pin this ADR
removes, to buy a softening the platform has no sellers to soften for. If it is
ever wanted, it is reintroduced at the **booking**, where the pin already exists.

## What would change this

**If the platform gains business sellers or a live category with real listings,
the notice mechanism stops being a gap and becomes a compliance requirement.**
That does not reverse this decision — it adds the announcement the decision
assumes.

**If a category ever needs its existing listings re-validated** — a bug in an
earlier validator, say — that is a migration with an explicit audit trail, as
ADR 0029 already says. It is not this mechanism and must not reuse it.

**If fee policy ever needs to vary by owner** — a negotiated rate for a large
supplier, a promotional period — the fee stops being category configuration
altogether and this ADR's second point no longer describes where to read it.
