# 0047. Price a period as the cheapest cover from the owner's own rates, and set no platform discount curve

- **Status:** Accepted
- **Date:** 2026-08-17
- **Relates to:** BRD §8.5.2, §8.5.3, §3.4.2, §3.4.4, §6.1, §6.2, §14 Phase 4; ADR 0002, ADR 0003, ADR 0034, ADR 0042
- **Decided by:** the product owner on 16 August 2026, taking the engineering recommendation after research was handed back. Implemented in slice 4.4b.

## Context

A listing carries up to three rates — daily, weekend and weekly (`ListingRateCard`)
— and a renter picks any number of days up to the statutory cap. **§8.5.2 names
the rates and stops.** Nothing in the BRD says how they combine, so _"what does a
ten-day hire cost?"_ had no answer in the specification.

The product owner settled the input side first, in their own words on 16 August
2026: _"regarding rates partner user should have option to choose any days from
1-30 days or more."_ That rules out fixed tiers alone — a renter must be able to
pick any duration — and "or more" is bounded at 88 days by §8.5.3, which is a
legal boundary rather than a preference (slice 4.4a).

**What the research found.**

| Who                                                             | How they do it                                                                                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hygglo** — the incumbent, and Fat Llama's successor in the UK | The owner sets **tiered price points at 1, 3 and 7 days**, described as "often discounted". A renter picks any dates. **No published rule for what happens between the tiers.**              |
| **HSS Hire** — traditional UK tool hire                         | Periods of 1, 2 and 3 days plus weekly; a weekend is charged at the **2-day rate**; and past the first week _"each day is charged at the Pro Rata Rate i.e. one seventh of the weekly rate"_ |
| **Fat Llama / Hygglo UK, in their own example**                 | _"£10 a day but £50 a week"_ — the discount is **the owner's to set**                                                                                                                        |

Two candidate rules were on the table. The obvious one is **decomposition**:
divide by seven, charge the whole weeks at the weekly rate, charge the remainder
daily. The other is a **platform-set discount curve** — a percentage we apply as
a hire lengthens.

## Decision

**A period costs the cheapest set of the owner's own rate units that covers _at
least_ the hire.** Days, weeks, and — for a hire that genuinely starts on a
Friday — the weekend. Whichever combination comes to least.

**The platform sets no discount curve.** The discount is the owner's, expressed
in the rates they chose.

Four consequences of that sentence, each deliberate:

1. **A hire may be charged for coverage it did not ask for.** Six days at a £10
   day and a £50 week costs £50, not £60 — it buys the week, because the week is
   cheaper and covers the six days.
2. **The weekend rate is anchored to a Friday start and usable once.** The other
   two rates are quantities; this one is an occasion. `ListingRateCard.weekend` is
   documented as _"Friday to Sunday as one charge"_, so that is what an owner
   setting it is pricing, and applying it to a Tuesday would charge weekend
   economics for a working day nobody agreed to discount. Two weekends in one
   hire prices something no owner chose.
3. **The fee is taken on the whole period's item charge, once** — never per day —
   because §3.4.2 puts a floor under _the platform fee on a booking_. Per-day
   application would turn a £1 minimum fee into £14 on a fortnight.
4. **§3.4.2's minimum booking total is enforced against the inclusive total**,
   which is what the renter pays and what the provider's fixed cost is levied on.

## Why coverage rather than decomposition

Decomposition is wrong in a way that produces a support enquiry nobody can
answer. With a £10 day and a £50 week:

| Days  | Decomposition | Cheapest cover |
| ----- | ------------- | -------------- |
| 5     | £50           | £50            |
| **6** | **£60**       | **£50**        |
| 7     | £50           | £50            |
| 8     | £60           | £60            |

**A renter pays more for less time.** Every honest explanation of that table
sounds like a defect, and the workaround — book seven days and return early — is
one a renter has to discover for themselves.

Framing the question as coverage rather than as decomposition makes the two
properties the decision was chosen for **structural rather than tested-and-hoped**:

1. **It can never charge more than the naive daily total**, because buying `days`
   days is always one of the candidates, so the minimum is bounded by it.
2. **It is monotonic in days**: anything covering `n + 1` days also covers `n`, so
   the feasible set only shrinks as a hire lengthens and the minimum can only
   rise. **No arrangement of rates can break this** — which a decomposition rule
   cannot say however many examples are tested.

There are tests for both anyway (`rental-quote.test.ts`, across seven rate shapes
and three weekday starts). **They exist to catch this file being rewritten into
the decomposition**, which is the "simplification" the next reader will reach for.

## Why no platform discount curve

Both incumbents leave the discount to the owner, and a curve we impose is a
number we would then have to defend to every owner whose earnings it changed. It
also fails the plainness test the rule has to pass: _"we work your dates out the
cheapest way from the owner's prices"_ is a sentence somebody can be told, and
_"we apply a tapering multiplier"_ is not.

**A per-listing discount field was not chosen either**, though §8.5.2 mentions
"configurable discounts". A weekly rate _is_ a configurable discount, expressed
in the unit an owner already understands — and a second mechanism producing the
same effect is two places for a price to come from.

## Consequences

**An owner can price themselves into a discount they did not intend.** Setting a
weekly rate below seven daily charges is what a discount _is_, and setting it
below _one_ daily charge would make a one-day hire cost the weekly price.
`listingRateCardSchema` deliberately does not refuse that — a rate card is the
owner's commercial decision and a validator second-guessing it would hard-code a
pricing opinion (§1.2) — so the guard is that the cheapest cover can only ever
_lower_ what they are paid relative to the daily rate they set.

**The line items are part of the contract, not decoration.** §6.2 puts line items
on the `Quote` entity, and here they carry which units were used — _"one week and
two days"_. That is what makes the price explainable a year later, and it is
stored on the quote rather than recomputed, because the rates may have changed.

**The weekend rate's narrow reading is reversible and the broad one is not.**
Treating it as a generic three-day price point later is deleting one condition.
Shipping the broad reading first and narrowing it afterwards would reprice every
listing that has one, silently, for hires nobody thought they were quoting.

**A quote pins the fee policy, which ADR 0042 placed in Phase 5.** That ADR says
the fee policy is read from the _current_ version and that the pin happens when a
commitment is made, and expected Phase 5 to be where that happened. A quote is
already a commitment — a firm total with an expiry — so `quotes.categoryVersionId`
is that pin, arriving one phase early. Nothing in 0042 changes.

**The duration cap is read from the current version, not the pinned one**, which
is the same distinction stated the other way round: a pinned version gives stored
answers their _meaning_ (a stored `25` is 2.5 kg), and a **rule** about what may
happen now comes from the current version. `rental-period.ts`'s docblock expected
the pinned cap; it is corrected. An administrator who narrows a category to thirty
days has to affect the next hire, not only the hires of listings whose owners
happen to edit them.

## Alternatives considered

| Option                                                                         | Why not                                                                                                                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weeks plus daily remainder** (decomposition)                                 | Six days costs more than seven. The table above.                                                                                                   |
| **Platform-set discount curve**                                                | A number we would have to defend to every owner; neither incumbent does it; not explainable in one sentence                                        |
| **Fixed tiers only**, as Hygglo has (1 / 3 / 7 days)                           | Ruled out by the product owner's instruction that a renter picks any duration                                                                      |
| **Pro-rata past the first week**, as HSS does (one seventh of the weekly rate) | It is a discount curve wearing a friendlier name, and it prices a day at a number the owner never typed                                            |
| **Charge the weekend rate for any 2–3 day hire**                               | Applies weekend economics to working days; not what the rate is named after; and it is the reading that cannot be narrowed later without repricing |
| **Let the owner enter a discount percentage**                                  | A second mechanism for the same effect, so two places a price can come from                                                                        |
