# 0033. Fee rates are stored as integer basis points

- **Status:** Accepted
- **Date:** 2026-08-07
- **Relates to:** BRD §3.4, §3.4.2, §6.1, §8.2, §6.2, §14 Phase 2; ADR 0002, ADR 0027, ADR 0028

## Context

Slice 2.7a gives a category version a **fee policy** — what the platform charges
on a booking in that category. BRD §6.2 names it on both `Category` and
`Category version`; §8.2 lists "fees, minimum booking total, minimum platform
fee" among the configuration an administrator sets without a deploy.

The two amounts are unambiguous: ADR 0002 and BRD §6.1 already require integer
minor units plus a currency code on the same record, and the floors are money.

**The rates are not money, and that is the question this ADR answers.** A
commission of fifteen percent is a ratio. Nothing in ADR 0002 obviously governs
it, and the obvious representations are all defensible on their face:

- a decimal fraction, `0.15`;
- a percentage as a number, `15`;
- a `Decimal` column, which Postgres offers and Prisma supports;
- an integer count of some smaller unit.

The rate is also the one field on the policy that the DMCC regime reaches
through §3.4.4: the renter fee is a mandatory fee, so every price displayed
anywhere must already include it, which means this number is multiplied by an
amount on every search result, listing card and listing page the platform will
ever render.

## Decision

**Fee rates are stored and transported as integer basis points — hundredths of a
percent. Fifteen percent is `1500`.**

Two CHECK constraints hold the range in the database (`fee_rates_are_within_bounds`,
0 to 5000) alongside the contract's `feeBasisPointsSchema`, and
`basisPointsToPercent` is the single named conversion to the percentage
`Money.percentageOf` expects.

**The administrator-facing form asks for a percentage**, and the conversion to
basis points happens once, server-side, in `readFeePolicy`.

## Why

**A float rate defeats ADR 0002 one step before the ledger.** The money
invariant bans floating point from amounts because `1.15` has no exact binary
representation. A rate is not an amount — and it is what an amount gets
multiplied by, so a float here reaches the ledger exactly as surely. Storing
`0.15` and multiplying is the same defect as storing `£10.15` as a double, moved
one operand to the left where the existing rule does not obviously catch it. It
is worth writing down precisely because ADR 0002's wording does not cover it and
somebody reading only that rule would conclude a `Float` column is fine.

**Whole percent is not enough, and the failure is a validator introducing an
error.** Twelve and a half percent is a rate somebody will want — it is inside
§3.4's recommended 12–20% band. A percent-granular field forces it to 12 or 13,
which is a 0.5% error on every booking in the category, introduced by the schema,
and discovered by whoever reconciles the payouts rather than by anybody
configuring it.

**`Decimal` would work and buys nothing here.** Postgres `NUMERIC` is exact, so
it is not wrong. But Prisma surfaces it as a `Decimal` object that has to be
converted before it can meet `Money`'s arithmetic, and that conversion is where a
float gets its chance. An integer needs no conversion at all: `percentageOf`
already takes a `number` and already rounds under a stated mode. Fewer moving
parts on the path between configuration and somebody's payout.

**Basis points are a unit the finance domain already uses**, so the arithmetic
does not need a bespoke scale factor explained in a comment. `Scaled` from
slice 2.4b was considered and rejected for the same reason it exists: its scale
is _category configuration_, chosen per attribute, and a fee rate must not have a
scale that varies by who configured it.

**The form asks for percent, and that is not a cosmetic choice.** Nobody thinks
in basis points. An administrator asked for one eventually types `15` and
configures a category at 0.15% — a hundredfold error that is a perfectly valid
value, so nothing can detect it. Asking for the unit people think in and naming
the conversion at the boundary is 2.4b's rule for scaled numbers, applied to a
second field: the client sends what somebody typed, and the server owns what it
means.

## Consequences

- **`basisPointsToPercent` is the only place the unit changes**, and it is named
  rather than inlined, because `percentageOf(total, 1500)` is a well-typed call
  that charges fifteen times the booking value.
- **The database holds the bounds too.** `MAX_FEE_BASIS_POINTS` is a constant in
  a TypeScript file somebody can raise in one line, and what it guards is how
  much money the platform takes from a stranger — the same argument that put
  `fuzz_offset_is_within_bounds` in the database in ADR 0032.
- **The recommended band from §3.4 is guidance, not a constraint.** The form
  shows 12–20% and 5–12%; nothing enforces them. §3.4 is explicit that the
  ranges carry no public commitment, and a deliberate decision to move outside
  them must not require a deploy. This is the distinction
  `MAX_CATEGORY_ATTRIBUTES` already draws against
  `RECOMMENDED_MAX_CATEGORY_ATTRIBUTES`.
- **Zero is a legal rate.** A promotional or supply-first category may take
  nothing, and refusing zero would mean the only way to express it is a deploy.
  It is also what every category configured before this slice carries, because
  no backfill invents a fee nobody agreed to.
- **A category is therefore "priced" or "not priced", and the two look the same
  in the data.** `isFeePolicyConfigured` reads the rates rather than a flag, so a
  category deliberately set to 0% is indistinguishable from one nobody has
  priced. That is accepted: §8.2 already forbids enabling a category for public
  booking before §3.4.3's worked example exists, so neither can reach a renter
  without somebody having looked at the numbers.
- **The rates live on the version, never on the category.** That is §8.2 rather
  than a choice — a booking must be readable under the terms it was made under,
  and only a row a trigger refuses to UPDATE can answer "what did we charge
  _then_". The same reasoning ADR 0028 applied to the reportable-activity flag,
  and stronger here: a reinterpreted flag is a compliance problem, a
  reinterpreted rate is somebody's payout being wrong.

## Alternatives rejected

| Option                       | Why not                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Float`/`Double` fraction    | Defeats ADR 0002 one operand early. `0.15` is inexact and the error is inherited by every amount the rate multiplies                       |
| Integer percent              | Cannot express 12.5%, which is inside the recommended band. A 0.5% error per booking introduced by the schema                              |
| `Decimal` / `NUMERIC`        | Exact, so not wrong — but needs conversion before meeting `Money`, and the conversion is where a float gets its chance                     |
| `Scaled` from slice 2.4b     | Its scale is per-attribute category configuration. A fee rate whose precision varies by who configured it is the problem, not the solution |
| Basis points in the form too | Nobody thinks in them. `15` typed meaning 15% is a valid basis-point value, so a hundredfold error is undetectable                         |
| Rates on `Category`          | §8.2 requires a booking to retain the configuration it was made under. A mutable rate answers "now", not "then"                            |
