# 0028. Confirm reporting scope per request, and keep the seller tax profile empty

- **Status:** Accepted
- **Date:** 2026-08-04
- **Relates to:** BRD §8.14.1, §8.14.2, §8.2, §6.2, §17

## Context

The platform is category-agnostic, and one consequence of that is unusual: **a
configuration change can alter our regulatory status.**

BRD §8.14.1 determined that under the UK digital platform reporting rules, a
Relevant Activity is only the sale of goods or a Relevant Service, and a
Relevant Service is only rental of immovable property, a Personal Service, or
rental of a means of transport. Renting out tools and garden equipment is none
of those, so we are not a Reporting Platform Operator and no seller tax data is
collected.

That conclusion holds for the launch category and for nothing else. Adding
trailers, vans, e-bikes, mobility scooters or anything labour-based makes us a
Reporting Platform Operator, with duties to collect and verify seller tax data,
register with HMRC, file an annual return by its deadline, and eventually block
sellers who do not supply their details. §8.14.2 therefore requires a
per-category `reportable-activity` flag, a warning, an explicit confirmation,
and counsel confirmation before any non-`none` category is enabled. §17's risk
register names the failure mode plainly: _reporting scope changing with a
category switch_ → undetected statutory reporting breach.

§14 also requires the `Seller tax profile` entity to exist from Phase 1,
"present but inactive", so activation is a configuration switch and not a
rebuild. It was never built, and slice 2.3 is where it lands.

Two questions had to be answered to build it, and both have an obvious-looking
answer that is wrong.

## Decision

**The confirmation is a required field on the request, and it is evaluated
against the value being saved rather than against the transition.**

`reportableActivity` is required on both the create and reconfigure bodies.
Alongside it, `reportingDutiesAcknowledged` must be `true` whenever the flag is
anything other than `none`, and the contract refuses the request otherwise —
before the service, the store or the audit log are involved. The same rule is
parsed by the web app's server action and expressed in the form as a warning
and a `required` checkbox that appears only when a reportable head is chosen.
The checkbox names counsel rather than asking for understanding, because
§8.14.2 requires counsel to have determined the scope beforehand and "I
understand" is something a person can honestly tick without that.

**The acknowledgement is not stored.** It is an assertion about a request, not a
property of a category. Every saved version carrying a reportable head was
necessarily acknowledged, so a column would record a constant.

**The flag lives on `category_versions`, not on `categories`**, with the rest of
the configuration — because §8.2 requires a booking to be interpreted under the
configuration in force when it was made, and a report has to answer _was this
activity reportable when it happened_, not _is this category reportable now_.

**The warning and the confirmation apply to reconfiguration as well as
creation**, which is wider than §8.14.2's literal wording.

**`seller_tax_profiles` is created with no personal-data columns.** It carries
the seller, the applicable regime and the verification state, and nothing else.
Its vocabularies are pinned by `CHECK` constraints rather than by TypeScript,
and no application code may reference it — an invariant rule enforces that.

## Consequences

- The one configuration value that can change our regulatory status cannot be
  set by omission, by a default, or by any client that has not met the
  confirmation. Three layers refuse it and only the API's refusal is a control.
- Editing anything on an already-reportable category re-asks for the
  confirmation, because the rule reads the value rather than the transition.
  That is mild friction, and it is deliberate: a transition-sensitive rule has
  to read current state to decide whether to enforce, which makes it stateful,
  makes the form and the API enforce different things, and puts the check
  exactly where a concurrent edit can defeat it.
- Reading a version whose head this build does not recognise **throws**. Falling
  back to `none` would answer "no statutory obligation" on the strength of not
  recognising a word, and the failure would surface as a missing annual return
  rather than as an error.
- `seller_tax_profiles` exists and does nothing, which will look like an
  oversight to anybody who does not read this. The invariant rule is what makes
  the omission speak: touching it fails the build with an explanation.
- When it activates, the collected fields are an expand step that must arrive
  **together with** `PersonalDataEraser` and both `PersonalDataSource`
  projections. Nothing enumerates the tables holding personal data, so a table
  that gains personal-data columns without them is silently absent from account
  deletion and from the data export.
- No module owns the entity yet. BRD §5.1 names no owner and it has no behaviour
  to place; the likely home is Payments & Ledger, because what gets reported is
  consideration paid to a seller.

## Alternatives considered

**A boolean `isReportable` instead of the statutory head.** Smaller, and wrong:
the collected fields and the deadlines differ between heads, and widening a
boolean later is a migration against rows that already carry statutory meaning.
§8.14.2 names four values; storing three of them as "true" discards the only
thing that says which rules apply.

**The confirmation as a form checkbox only.** This is what §8.14.2 literally
asks for — it says "the admin interface must warn". It was rejected because the
admin interface is not the boundary: anything holding an admin token can call
the route, and a control that exists only in the page it is drawn on is not a
control. The form still does it, as the layer that prevents the refusal rather
than delivering it.

**Storing the acknowledgement on the version.** Tempting as evidence. Rejected
because it would be `true` on every row that could exist, and a field that is
always true is eventually read as proof of something it never established. The
audit entry already records the actor, the reason and both digests, and the
digest includes the flag, so a change of scope is attributable without it.

**Warning on creation only, as written.** Rejected against §17. A new reportable
category is a deliberate act by somebody who knows what they are adding; the
dangerous case is an existing `none` category quietly becoming reportable, and
that is the one a creation-only rule waves through.

**Building the collected fields now, encrypted like `addresses`.** This is the
straightforward reading of §6.2, and it was rejected on two grounds. There is no
lawful basis to hold any of it while every category is `none`, and it would
create a fourth personal-data table outside the erasure and export paths with
nothing to detect the gap. An unused encrypted column is indistinguishable from
a broken one.

**Skipping the entity until reporting is real.** It is a BRD §14 line item, and
the point of it is that the shape and its relation to `users` are decided while
nothing depends on them. What was skipped is the data, not the decision.

**A Postgres enum for the flag, or a `CHECK` on `category_versions`.** Rejected
for consistency with `riskLevel` and `AuditLog.action`: the union lives in code
so adding a statutory head is a reviewed edit rather than a schema migration,
and the adapter already refuses an unknown value on read.
`seller_tax_profiles` is the deliberate exception, because it has no adapter —
there, the constraint is the only thing that can refuse anything.

## What would change this

- **Counsel confirms scope for a non-`none` category.** The first time this flag
  is set in anger, everything here stops being theoretical: revisit whether the
  acknowledgement should also be recorded somewhere a filing can cite.
- **The collected fields are built.** That is when `seller_tax_profiles` becomes
  a personal-data table, the invariant rule gets its first waiver, and the
  eraser and both projections must be extended in the same slice.
- **A second reporting regime becomes relevant** — an EU platform, or DAC7
  applying to us. `regime` exists for that, and its `CHECK` is a one-line
  migration on what is currently an empty table.
- **A statutory head is added or removed by HMRC.** The union is a deploy, by
  design; the flag on existing versions must not be rewritten when it changes.
