# 0036. Feature flags are audited but not versioned, and their vocabulary is code

- **Status:** Accepted
- **Date:** 2026-08-08
- **Relates to:** BRD §5, §9, §12, §8.13; ADR 0017, ADR 0021, ADR 0023, ADR 0027, ADR 0031, ADR 0035

## Context

BRD §5 asks for "feature flags for incomplete or high-risk capabilities", §9 for
"feature flags and emergency **kill switches** for payments, booking, messaging
and categories", and §12 for flags that "permit dark launch and rapid
disablement". Slice H3a builds the mechanism.

The session handoff described the work as _"config-driven in the database,
versioned and audited like categories already are"_. Every other piece of
configuration in this system is versioned, so following that would be the
consistent choice. It is the wrong one, and the reason is specific rather than
stylistic.

`category_versions` is immutable and versioned because §8.2 requires a booking
to retain the configuration version under which it was created. A booking
**pins** a version, so that row can never change for as long as anything points
at it.

**Nothing pins a flag.** A flag decides whether a code path runs at the instant
it runs. No entity records which flag values were in force when it was created,
and there is no query anywhere in the system for "what was this flag when that
happened" that the audit trail does not answer better.

There is a second question the BRD does not answer: **who decides what a flag
is.** A key is either something an administrator types into a form, or something
the build declares.

And a third, which only appears once the mechanism is real: **what a flag reads
as when the database cannot be reached.**

## Decision

**Flags are audited, not versioned.** There is one row per overridden flag,
updated in place. Every switch writes a `feature_flag.changed` audit entry
carrying actor, reason, target and before/after digests (§8.13), and the write
is awaited with its failure propagating (ADR 0017). The row also carries
`changedById` and `updatedAt` so the admin list can show them without a join.

**The vocabulary is a closed set declared in code**, in
`@platform/contracts/feature-flags.ts`. ADR 0031's rule for transport
requirements, transplanted: a flag key gates a code path and code paths are
code, so a key somebody typed into a form would gate nothing — a switch on an
admin page that changes no behaviour, which is a dead control with a database
row behind it. Adding a flag is a line in the declaration plus the `if` that
reads it, reviewed together.

**The database stores overrides, not flags.** A key with no row is not "off"; it
is at its declared default. Adding a flag therefore needs no migration, and a
row whose key the build no longer declares is ignored by the evaluator rather
than resurrected as a switch that gates nothing.

**Each flag declares its own default, and the default is what a failed read
returns.** `isEnabled` never throws: when the store cannot answer, the declared
default stands and the failure is logged at `error`. The direction is per flag
because the safe direction differs — a kill switch over working functionality
defaults **on**, since defaulting off would turn a database blip into an outage;
a flag over an incomplete capability defaults **off**.

**Reads are cached for ten seconds; the admin surface reads through.** Flags gate
hot paths by definition, so an uncached read is a database round trip per
request. Ten seconds is short enough that "rapid disablement" is immediate to a
human. The admin list bypasses the cache, and a switch drops it, because an
administrator who has just thrown a switch and sees the old value cannot
distinguish that from a write that failed — and will throw it again.

**There is no dual approval.** ADR 0023 requires two administrators for a role
change because that grants standing power and can always wait. §9 asks for
_rapid_ disablement, and a control needing a second person is unavailable at 3am
to the one person awake. The compensating controls are the second factor
(ADR 0021), the audit entry, and a `warn` log on every change.

## Consequences

**An outage returns every flag to its default**, so a kill switch that was off
comes back on if the database is unreachable and the cache has expired. That is
the deliberate cost of the fail-safe, it is why each default's direction is a
per-flag decision, and it is tested.

**The override table carries a synthetic uuid** even though `key` is a perfectly
good natural key. `audit_logs.targetId` is a `uuid` column, so anything audited
must have one. `key` is unique instead. This was found by writing the test —
the first design used the key as the primary key and the audit fake refused it.

**The audit entry names the flag by uuid, not by key.** The key travels in the
digested before/after state. `category.created` is in exactly the same position,
recording a category's uuid rather than its slug, so this is the established
shape rather than a new gap.

**A flag is a permanent branch with two paths that both have to keep working.**
Each one is a standing cost, which is why the declaration is meant to stay short
and why §5 scopes flags to incomplete or high-risk capabilities rather than to
everything.

**`ListingsService` gained a dependency**, taken as a one-method port
(`PublicationSwitch`) that Catalogue declares and the flags module answers —
the shape `ListingLocator` already uses. Handing it the whole flag service would
let a later slice switch a flag from inside a listing operation, with no
administrator and no reason behind it.

**Publication now refuses with 503 rather than 422 when the switch is off.** 422
means "the state of your listing is wrong" and would send an owner looking for a
field to fix; nothing is wrong with their listing.

## Alternatives considered

**Versioned flags, mirroring `category_versions`.** Rejected: it adds a table and
an immutability trigger for no invariant, since nothing pins a flag — and it
makes a kill switch slower to operate in exactly the incident it exists for.
Consistency with categories would be consistency of mechanism where the reason
for the mechanism is absent.

**Flags as rows an administrator creates.** Rejected as a dead-control factory. A
key nothing in the code reads is a switch that changes nothing, and the
administrator has no way to tell it from one that works.

**Environment variables**, as `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA` is. Rejected
for this purpose: changing one needs a deploy or at least a restart, which is
the opposite of "rapid disablement", and it leaves no audit trail and no reason.
The env flag remains right for _its_ job — ADR 0030's escape hatch must be
impossible to switch on at runtime.

**No cache.** Rejected: flags gate hot paths, so it puts a query on every
request on precisely the paths that matter — the cost slice H2 had just finished
removing elsewhere.

**A long cache, or one refreshed by a background job.** Rejected: both make
disablement slow, and a background refresher adds a moving part that fails
silently.

**Defaulting every flag off.** Rejected. It sounds safe and is not: a kill switch
over working functionality that defaults off means any database interruption
stops that functionality for everybody, which is a larger outage than the one the
switch exists to prevent.

**Dual approval on switching.** Rejected — see the decision. Worth revisiting if
the platform ever has enough administrators for it not to mean "unavailable".

## What would change this

**A flag that something needs to pin.** If a booking, a payout or a dispute ever
has to be interpreted under the flags in force when it was created, that flag is
not a flag — it is versioned configuration, and it belongs on a version row.

**A second administrator existing.** Dual approval on the more destructive
switches becomes affordable at that point, and the argument against it here is
availability rather than principle.

**Flags needing to differ per environment, per user or per percentage.** All
three are real product features and none is this. A percentage rollout in
particular needs a different evaluator and a different audit story, and bolting
it onto this one would be the point to stop and design rather than extend.

**Reaching more than a handful of flags.** The declaration is meant to stay
short. A long list is the signal that flags are being used where configuration
or a deploy belongs.
