# 0031. The transport requirement is a platform vocabulary a category selects from

- **Status:** Accepted
- **Date:** 2026-08-05
- **Relates to:** BRD §8.3, §8.4, §8.9, §6.2, §14 Phase 2; ADR 0025, ADR 0027, ADR 0029

## Context

BRD §8.3 gained a paragraph on 26 July 2026 that no other listing field has:

> Each listing declares what is needed to collect and carry the item — for
> example hand-carryable, car boot, estate or van required, two-person lift, or
> trailer. […] The requirement must therefore be: captured at listing creation,
> **with category-appropriate options as versioned configuration**; displayed on
> the listing page and in the booking summary before the booking is submitted;
> carried into the collection instructions and the handover checklist; available
> as a **search filter** where the category makes it meaningful.
>
> Item weight, where captured as an attribute, should drive a **suggested
> default** for this field rather than being asked twice.

The reason it exists is in the research record (Appendix A.4): a depot operator
controls collection, and we do not. In a peer-to-peer model the renter drives to
a stranger's house, and an item that will not fit their car is a failed handover,
a dispute and two unhappy users — the failure our differentiator is supposed to
be about preventing.

Two things about that paragraph decide this ADR.

**"Category-appropriate options as versioned configuration" has two readings.**
Either each category invents its own option list, exactly like a `choice`
attribute, or the platform holds the vocabulary and each category selects the
subset that applies to it. The sentence is satisfied by both.

**The example list mixes two axes.** Hand-carryable, car boot, estate, van and
trailer form one progression — how much vehicle is needed. "Two-person lift" is
not on that progression at all: it is about lifting, not carrying, and an item
can need a van _and_ two people.

There is also a standing note from ADR 0027 addressed to whoever built this:
`unit` on a `number` attribute is free text and means nothing to the system, so
anything that needs to know an attribute **is** a weight must key off the
attribute key and never parse the unit string.

The cheap thing to do was nothing. `power_source` is already a four-option
`choice` attribute; a `transport` attribute would have been five minutes of
configuration and no code.

## Decision

**The transport requirement is a first-class field, not a category attribute.**
§8.3 requires it in the booking summary, in the collection instructions, in the
handover checklist and as a search filter. Each of those is code that must be
able to ask _any_ listing what it needs. An attribute can answer that only for
categories whose administrator happened to configure the right key — which is the
same argument that made `accessories_included` a listing field in 2.4b, and it is
stronger here because three later phases depend on the answer.

**The vocabulary is closed and belongs to the platform; the selection belongs to
the category version.** Five values, in display order:

| Value                 | Means                                             |
| --------------------- | ------------------------------------------------- |
| `hand_carryable`      | Carried by hand, on foot or on public transport   |
| `car_boot`            | Fits in an ordinary car boot                      |
| `estate_or_hatchback` | Needs an estate, a hatchback or folded rear seats |
| `van_required`        | Needs a van or a large panel vehicle              |
| `trailer_required`    | Needs a trailer and something to tow it           |

Each `category_versions` row stores which of these it offers. Adding an option to
a category is configuration; adding a **value** to the vocabulary is a deploy —
ADR 0027's rule, for the same reason. A type is a renderer; a transport value is
something Phase 3's filter and Phase 7's checklist must both reason about.

This is what settles the ambiguity above. If each category invented its own
strings, a renter filtering _"fits in my car boot"_ in Phase 3 would match
listings in one category and miss them in another, because `van` and
`van_required` are two different filters. Cross-category comparability is not a
nicety here — it is the whole point of a distance-and-vehicle search.

**"Two-person lift" leaves the list and becomes its own field on the listing.**
Keeping it in a single-choice vocabulary would force an owner with a 90 kg
chipper to state either that it needs a van or that it needs two people, and to
discard the other. Two axes, two fields.

**The weight suggestion is driven by thresholds stored beside each offered
option.** A category may say _car boot — up to 15 kg_, _van required — up to
100 kg_. The suggestion is the offered option with the smallest threshold at or
above the entered weight. Thresholds are optional: a category that sets none
suggests nothing, which is a no-op rather than a wrong nudge. They must increase
down the display order, because a configuration where the van threshold is below
the car boot's is a mistake somebody made rather than a policy.

They live on the version, with the rest of the configuration, because CLAUDE.md's
rule is that anything which might change without a deploy is configuration — and
because §8.2 requires a booking to be interpretable under the configuration in
force when it was made.

**The weight is read from an attribute with the well-known key `weight_kg`**,
which the platform recognises and nothing else does. ADR 0027's instruction,
followed literally: the key is the contract, the unit string is decoration. A
category with no such attribute gets no suggestion, which is exactly what §8.3's
_"where captured as an attribute"_ allows.

**It is a suggestion, not a rule.** It pre-selects, it says why it did, and the
owner can change it to anything the category offers. Nothing refuses a listing
for disagreeing with its own weight.

## Consequences

**Adding a transport value requires a deploy**, and that is the cost of the
filter working across categories. The five values cover every launch-category
item; the first category that genuinely needs a sixth gets a code change and this
ADR revisited, not a configuration escape hatch.

**The display order is a display order, not a capability lattice.** It is
tempting to read the list as ranked, and mostly it is — but somebody with a van
cannot necessarily tow, so `trailer_required` is not simply "more than"
`van_required`. Nothing in this slice relies on the ranking: the suggestion is
driven by the configured thresholds, not by position. **Phase 3's filter must
therefore be a multi-select of what the renter can do, not a "no more than X"
slider.** A slider would silently exclude the towing renter from trailer
listings.

**A category configured before this slice offers no options**, so its listing
form asks nothing about transport and the listing stores nothing. No backfill
invents a selection nobody chose — the same treatment the attribute schema got in
2.2. It leaves slice 2.8 a question it must answer: whether publication requires
a transport requirement, and what that means for a category that offers no
options.

**Renaming a category's weight attribute key silently stops the suggestion.**
There is no error, because there is nothing wrong — the category simply no longer
has a weight the platform recognises. The admin editor says so at the point where
the thresholds are typed, which is the only place anybody would be surprised.

**There is no value for a long, light item.** A ladder needs roof bars and weighs
nothing, which is a third axis. `outdoor-gardening` has no ladders, and inventing
a value now would put a guess in a vocabulary that costs a deploy to correct.

**The suggestion can be wrong and the owner is the check.** Weight is not bulk: a
5 kg garden parasol and a 5 kg drill do not travel alike. That is why this
suggests rather than decides, and why the field is asked at all rather than
derived.

## Alternatives considered

**Configure it as a `choice` attribute per category.** Free, immediate, and it
defeats three of §8.3's four bullets. A handover checklist that works only where
an administrator configured the right key is not a checklist, and a search filter
whose values differ per category cannot be a facet. It would also make the
booking summary read a category's attribute schema to find out whether the
question was asked — logic no booking should contain.

**Free-form options per category, like attribute options.** Satisfies the letter
of "category-appropriate options as versioned configuration" and breaks the
filter, because two categories would spell the same physical fact differently
with nothing to notice. The `key`/`label` split ADR 0027 made for attributes
solves the display half of this and not the comparability half.

**Keep `two_person_lift` in the one vocabulary, as the BRD's list has it.** Loses
data on every item that is both heavy and bulky, and makes the vocabulary a mix
of two questions that later code would have to disentangle by knowing which
values mean which. Departing from the BRD's example list is deliberate and is
recorded here because the list is illustrative — "for example" — while the four
bullets under it are requirements.

**Platform-wide thresholds in code rather than per category.** Genuinely
tempting: weight is physics, and a 30 kg shredder travels like a 30 kg anything
else. Rejected because it puts a tunable number in a deploy for no gain, and
because bulk-to-weight ratios do differ by category — garden furniture against
power tools — so the numbers are not as universal as they look.

**Derive the requirement from weight and do not ask.** The most convenient
reading of "should drive a suggested default", and wrong: §8.3 says _suggested_,
and weight does not determine bulk. A folded gazebo would be filed as
hand-carryable.

**Store the selection on `Category` rather than on the version.** Would make a
reconfiguration change what an already-created listing claims about itself,
which is what §8.2 and the immutability trigger exist to prevent.

**Defer the whole thing to Phase 3, where the filter lives.** The field has to be
captured at listing creation (§8.3), and adding it after listings exist means
either a backfill that invents answers or a population of listings that can never
be filtered.

## What would change this

If a category arrives needing a **long or awkward** item that is light — ladders,
scaffold boards, lengths of timber — the vocabulary needs a value or the model
needs a second axis. Prefer the second axis: cramming it in as a fifth vehicle
size would repeat the two-person-lift mistake this ADR corrected.

If Phase 3 finds that renters think in terms of **their own vehicle** rather than
the item's need — likely — the filter is a capability multi-select mapped onto
these values, and that mapping is where the ranking question resurfaces properly.

If a category ever needs its weight attribute under a different key, the
well-known key becomes a per-category setting. Do not add a second recognised key
in code; that is two silent behaviours where there was one.
