# 0052. Cap the applied excess at the recovery ceiling, and read an unset band as no security

- **Status:** Accepted
- **Date:** 2026-08-21
- **Relates to:** BRD §8.7.1, §8.7.2, §6.1

## Context

BRD §8.7.2 adopts the three-part excess model UK hire operators use, as versioned
per-category configuration:

| Component         | Rule                                            |
| ----------------- | ----------------------------------------------- |
| Excess floor      | A fixed minimum the renter always bears         |
| Excess percentage | A percentage of the item's replacement value    |
| Applied excess    | **The greater of the floor and the percentage** |
| Recovery ceiling  | A maximum recoverable amount per booking        |

Two things it does not say in so many words, and both have to be settled before
any code can compute an amount.

**First, whether the ceiling binds the applied excess.** §8.7.2 states the `max`
explicitly and describes the ceiling only as capping "renter exposure", in a
different row of the same table. Read narrowly, the applied excess is the greater
of two numbers and the ceiling is a separate rule applied somewhere later.

The constraint that decides it is §8.7.1's, not §8.7.2's. **The amount held is a
hard ceiling on what can be taken from the card** — overcapture is unavailable to
this platform — and §8.7.2 requires the hold to be sized to _at least_ cover the
applied excess. So the applied excess is what we ask a renter to authorise. A
category configured with a 20% excess and a £500 ceiling would, on a £4,000
plate compactor, ask for an £800 hold against a liability capped at £500: we
would be holding £300 we have already published that we will never recover.

**Second, what an unconfigured category means.** §8.7.2 says a booking may not
enter `READY_FOR_COLLECTION` until security is authorised, _"unless the category
is configured to require no security"_ — so the no-security case is real and must
be expressible. The launch categories predate the field entirely, and a migration
that invented numbers for them would be writing commercial policy in SQL.

## Decision

**The applied excess is `min(ceiling, max(floor, percentage × replacement value))`.**
The ceiling binds it. One function computes it, in the pricing module, because
§6.1 puts rounding there and nowhere else.

**A category version whose damage-security band is unset requires no security.**
The five columns are nullable all-or-nothing, enforced by a
`damage_security_is_complete` CHECK in the shape `location_is_complete` and
`suspension_is_complete` already use. In the contract the band is
`DamageSecurityPolicy | null`, never a boolean beside optional fields.

**The administrative form refuses a version that has not answered.** The
deliberateness lives at the moment of authoring, not in a column.

## Consequences

The hold can never exceed what we have told the renter is recoverable from them,
which is the property §8.7.1 makes matter — and it means a very high-value
listing in a category with a modest ceiling is **under-secured by design**. That
is not a defect: loss between the hold and the ceiling is the protection
product's scope from Phase 10, and above the ceiling it sits with the owner, who
§8.7.2 requires be told so before listing.

**Both launch categories read as requiring no damage security until an
administrator sets numbers.** Nothing enforces security yet, so this changes no
behaviour today — but from 5.5c it is the difference between a secured handover
and an unsecured one, and "nobody has configured it" is indistinguishable from
"we chose not to require it" for a row written before this migration. The
mitigation is that only two such rows exist, both on one laptop, and the form
prevents any new one.

A category can be configured so the ceiling binds every listing in it — a floor
above the ceiling would do it. Validation refuses that pair, so the cap is a
bound on unusual items rather than the normal case.

## Alternatives considered

**Leave the applied excess uncapped and apply the ceiling at claim time.**
Defensible on a literal reading, and it keeps the two rules independent. Rejected
because the hold is sized from the applied excess _before_ any claim exists, so
the ceiling would arrive too late to stop us authorising more than we can
recover. It would also make the number shown to a renter at booking differ from
the number that binds them, which §8.7.2 requires be disclosed up front.

**A `damageSecurityRequired` boolean beside nullable values.** The obvious shape,
and what the BRD's wording suggests. Rejected because it buys no safety where it
would matter: every row that predates the migration takes the default, so the
boolean would say `false` for exactly the rows we are worried about, while adding
a second invalid combination (`true` with no values) that the CHECK then has to
exclude anyway. It also permits `false` _with_ values, which reads as a category
that has a band and ignores it.

**Backfill the launch categories with plausible numbers.** Rejected under the
same rule that keeps `seed-dev.mjs` away from real configuration: a migration
that picks a £75 floor and 15% is a commercial decision made by whoever wrote the
SQL, carrying no audit entry and no `category.reconfigured` event. The product
owner sets them through the form, as they did the fee change on 21 August.

**Store the percentage as a decimal fraction.** Rejected by ADR 0033, which
already settled that fee rates are integer basis points. A second unit for a
second percentage on the same table is how `0.15` and `1500` come to be confused.

## What would change this

If Phase 10's protection partner turns out to price against the _uncapped_
liability, the cap stops being purely protective and starts changing what the
partner is quoting on — revisit the first half then.

If a category ever legitimately needs a hold above its recovery ceiling — a
returnable-container model, say, where the deposit is not an excess at all —
that is a different instrument rather than a wider cap, and it wants its own
configuration rather than a relaxation of this one.
