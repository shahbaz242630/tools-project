# 0027. Make category attributes a closed typed vocabulary, not JSON Schema

- **Status:** Accepted
- **Date:** 2026-08-03
- **Relates to:** BRD §8.2, §8.3, §14 Phase 2; ADR 0002, ADR 0017

## Context

BRD §8.2 says each category supports "a JSON-schema-like set of required and
optional attributes". BRD §14 sets the Phase 2 exit gate: _"A new category can be
added by configuration, and a listing renders its category-specific fields
without frontend code changes for every field."_

Those two sentences pull in opposite directions, and the tension is the whole
decision. The first invites a general schema language. The second requires that
**everything the language can express, some renderer can draw** — because a
configured field the frontend cannot render is a field that needs a frontend
change, which is the gate failing.

Real JSON Schema is far more expressive than any generic renderer can honour.
Draft 2020-12 has `oneOf`, `allOf`, `if`/`then`, `$ref`, `patternProperties`,
nested objects and arrays of arbitrary depth. An administrator with a JSON Schema
field could write a valid schema on Tuesday that the listing form silently
ignores on Wednesday, and nothing in the system would report a problem: the
storage accepted it, the validator honoured it, and only the renderer quietly
did not.

The category research (`docs/reference-category-taxonomy.md`) constrains it from
the other side. A mature UK hire operator with thousands of products exposes
**three attributes per product** and offers no attribute-based filtering at all.
Across the categories sampled, the attributes cluster into five recurring shapes:
an enumerated power source, a weight, a capacity number with a unit, a free-text
motor specification, and a list of included accessories. The expressive power
actually required is small. The expressive power JSON Schema offers is unbounded.

## Decision

**A category version carries an ordered list of attribute definitions drawn from
a closed vocabulary of four types.** Adding an _attribute_ is configuration.
Adding a _type_ is a deploy.

| Type          | Carries              | Renders as                         |
| ------------- | -------------------- | ---------------------------------- |
| `text`        | maximum length       | a text input                       |
| `number`      | unit, decimal places | a numeric input with a unit suffix |
| `choice`      | options              | a select                           |
| `choice-many` | options              | a checkbox group                   |

The line between configuration and deploy sits there because **a type is a
renderer**. Every type in the vocabulary has exactly one input control, one
validator and one display form, and that correspondence is what makes the exit
gate a property of the system rather than a coincidence of which fields somebody
happened to configure.

**Numbers are scaled integers, never floats.** A `number` attribute declares
`decimalPlaces` between 0 and 3, and the value it will eventually carry is an
integer in the smallest unit that implies — 2.5 kg is `25` at one decimal place,
and 18 mm is `18` at zero. Not because a weight is money, but because the same
argument applies: `parseFloat` is banned project-wide by the invariant checker
for ADR 0002's reasons, Phase 3 will filter and bucket on these values, and a
float that is harmless in a form field is not harmless as a search facet. It also
gives the renderer everything it needs to format a value without `toFixed`.

**A `number` carries no minimum or maximum yet.** Bounds are constraints on a
value, and the validator that enforces them arrives in slice 2.4 with the first
values to enforce against. Shipping the fields here would put two numbers in the
database that nothing reads and nothing checks, which is indistinguishable from a
bound that has stopped working. `decimalPlaces` is different and belongs here: it
declares the _scale_ a value is stored at, which the schema must fix before any
value exists, or two listings in one category mean different things by the same
integer.

**Attributes never hold money.** Fees, deposit bands, minimum totals and the
damage excess rule are typed fields on the category version with a currency code
beside them, arriving in slice 2.7. A generic decimal attribute would be a back
door around ADR 0002 — an administrator could configure `daily_rate` as a
`number` and the platform would carry a price with no currency, in a shape no
pricing service knows to look at. The prohibition is stated here because the
vocabulary makes it physically possible and nothing else would stop it.

**The schema lives in a `jsonb` column on `category_versions`, not in a child
table.** The version row is already immutable — a trigger refuses `UPDATE`
(slice 2.1) — and a JSON column inherits that guarantee for free. A child table
would need its own immutability story, because nothing stops a row being
appended against a version written last month, and that row would silently change
the terms of every booking already pinned to it. The schema is also always read
whole, never queried attribute by attribute, and its order is meaningful: it is
the order the fields render in.

**Boolean is deliberately absent.** It is a `choice` with two options, and every
type in the vocabulary is a case every renderer, validator and exporter must
handle for as long as the platform exists.

**Everything is bounded before storage**: at most 12 attributes per category, at
most 24 options per attribute, and length caps on the key, the label, the unit
and each option. Keys are `snake_case` and unique within a schema.

## Consequences

**A category cannot express a shape the vocabulary lacks, and some will want
one.** A date, a postcode, a duration and a URL are all plausible and none exist.
The answer is to add the type, with its renderer and its validator, in a slice —
not to reach for an escape hatch. There is deliberately no `custom` or `json`
type, because one would reintroduce everything this ADR rejects while looking
like a small addition.

**The 12-attribute cap is a bound, not a policy.** It exists so an administrator
cannot store unbounded JSON or produce a page nothing can render, and it sits far
above the 3–6 the research recommends. The recommendation belongs in the
interface as guidance; the cap belongs in the validator as a limit. Confusing the
two would make a commercial finding into a hard constraint.

**`unit` is free text and means nothing to the system.** It is a display suffix.
Anything that needs to _know_ an attribute is a weight — §8.3 wants item weight
to suggest a default transport requirement — must key off the attribute key, not
parse the unit string. A closed unit vocabulary was rejected as a deploy for
every `psi` and `dB` a future category wants.

**Reordering attributes is a configuration change and mints a version.** The
audit digest canonicalises objects but preserves array order deliberately
(ADR 0017), so a reorder registers as a real change rather than a no-op. That is
correct — the order is what an owner filling in the form sees — but it means a
cosmetic drag produces a version, and administrators should be told that rather
than surprised by it.

**Existing category versions get an empty schema, honestly.** The migration
defaults `attributes` to `[]`, which is what a category configured before this
slice actually had. No backfill invents a schema nobody chose.

**Nothing validates attribute _values_ yet.** That belongs in slice 2.4, where
the first listing supplies some. The definition-time rules here — a `choice` must
offer more than one option, option values are unique and stable, a scale is fixed
before any value exists — are written so that validator has no ambiguity left to
resolve when it arrives.

## Alternatives considered

**Real JSON Schema, validated with `ajv`.** The most obvious reading of §8.2, and
it fails the exit gate for the reason above: it can express far more than any
generic renderer can draw, so the gate would hold only for the subset we happened
to implement, with no mechanism preventing an administrator leaving it. It also
adds a dependency and a validation-error vocabulary aimed at developers —
`must match pattern "^[0-9]+$"` is not a message to show somebody listing a hedge
trimmer.

**A restricted JSON Schema profile**: accept JSON Schema, reject the keywords we
cannot render. Closer, and rejected because the rejection list is unbounded and
grows with the specification. We would be maintaining a denylist against a
standard we do not control, and every draft revision is a new way to smuggle in
something unrenderable. A closed vocabulary is the same idea expressed as an
allowlist, which is the direction that fails safe.

**Free-form key/value strings.** Cheapest possible, and it pushes every cost
downstream: no input control better than a text box, no validation, no way for
the handover checklist to know what an accessory is, and a search facet in
Phase 3 that has to guess whether `18mm`, `18 mm` and `18` are the same value.

**A child table, one row per attribute definition.** Relationally tidier, and
queryable — which is the benefit, except nothing queries a definition. It loses
on immutability: the version's trigger protects the version row, not rows
pointing at it, so the guarantee §8.2 depends on would have to be rebuilt with a
second trigger. It also needs an explicit position column to preserve render
order, which the JSON array gives for nothing.

**Storing decimals as JSON numbers.** Simpler to write and read. Rejected
because it puts an IEEE 754 float in the database and the API contract for
values that Phase 3 will compare and bucket, and because the project already
pays this exact cost deliberately for money (ADR 0002). Paying it twice with
opposite answers is how a codebase stops having rules.

**A `boolean` type.** Genuinely convenient for "petrol included?" and rejected as
the fifth case in every switch statement in the platform, for a shape the fourth
already covers.

## What would change this

If a category needs a field the four types cannot express, add a fifth type with
its renderer, validator and display form together, and note it here. The
vocabulary growing slowly is the design working; the vocabulary being escaped is
the design failing.

If attribute values ever need to drive search facets with range queries at
volume, the `jsonb` column on the _listing_ side (slice 2.4) may need GIN
indexing or promotion to typed columns. That is a decision about values and
belongs to whichever slice hits the limit — the definitions here are read once
per page and will not be the thing that hurts.

If a second administrator ever needs to edit a schema concurrently with another,
note that the existing concurrency control still applies unchanged: both compute
the same next version number and the unique constraint on
`(categoryId, versionNumber)` refuses the second write. Attributes add no new
race, because they are part of the row that constraint already protects.

If BRD §8.2 is ever amended to require genuine JSON Schema — for an integration
that consumes it, say — this ADR should be superseded rather than quietly
widened, because the exit gate argument would need re-making rather than
restating.
