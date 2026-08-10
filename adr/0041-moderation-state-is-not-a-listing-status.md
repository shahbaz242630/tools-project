# 0041. Moderation state is its own field, not more values in the listing status

- **Status:** Accepted
- **Date:** 2026-08-10
- **Relates to:** BRD §8.3, §9, §10.1, §14 Phase 2 and Phase 9; ADR 0017, ADR 0024, ADR 0031

## Context

BRD §8.3 says listings _"pass automated moderation and, where flagged, manual
review"_, and the §14 Phase 2 list asks for **"listing moderation status"**. Two
neighbouring items are deliberately elsewhere: **manual moderation queues are
Phase 9** and **automated prohibited-content signals are Phase 6**. So what
Phase 2 owes is the state a listing can be in and the administrative action that
sets it — not a scanner and not a queue.

Slice 2.8a wrote the listing status vocabulary as a closed union in code and left
a note saying _"the moderation states in 2.8c"_ arrive beside `DRAFT`,
`PUBLISHED` and `PAUSED`. Slice 2.8b repeated that assumption in two more
comments and in the transition table's docblock. **This ADR contradicts all
three.** They were written before anybody had to reconcile a moderator's decision
with an owner's intent, and the reconciliation is the whole problem.

The question is whether `UNDER_REVIEW` and `REJECTED` are more values of
`listings.status`, or a second field beside it.

**Status answers "what does the owner want".** `DRAFT` is not finished,
`PUBLISHED` is offer it, `PAUSED` is not right now. Every transition in 2.8b is
performed by the owner, and each of them is an expression of intent.

**Moderation answers "what does the platform permit".** It is performed by
somebody else, for reasons the owner may disagree with, and it is not an
expression of their intent at all.

The two are independent in fact. A listing can be published and under review; it
can be paused and rejected; an owner can pause a listing that is under review,
and that pause has to mean something afterwards.

## Decision

**A second column, `moderationState`, beside `status`.** A closed union in code,
as `status`, `riskLevel`, `reportableActivity` and `transportRequirement` are,
with no Postgres enum and no CHECK constraint — the convention slice 2.4a's
migration records.

**`isPubliclyVisible` reads both**, and remains the single place either is
interpreted. A listing is visible when the owner has published it **and** the
platform permits it. That function already existed for this reason: 2.8a wrote it
when there was one status and one rule, precisely so the rule could grow without
every caller learning about it.

**Only an administrator writes it, and every write is audited** (BRD §8.13, §9).
That is the difference from 2.8b, which deliberately wrote no audit entry: an
owner pausing their own listing is not an administrative act, and a moderator
rejecting somebody else's is.

**A reason is required on any state that hides a listing**, stored beside it. §9
requires administrative actions to carry one and ADR 0024 already establishes
that a person reads the reason for a decision made about them.

## Consequences

**A moderator's decision cannot destroy an owner's intent, and neither can undo
the other.** Rejecting a published listing leaves `status = PUBLISHED` and stops
it being visible; reinstating it restores visibility without anybody having to
remember, or guess, what the owner wanted. With one field, reinstatement would
have to pick a status — and picking `PUBLISHED` would silently republish a
listing whose owner had paused it in the meantime, which is the worst outcome
available.

**An owner can still pause a rejected listing, and it stays rejected.** The two
writes do not contend, so neither needs to lock or check the other.

**Every reader must ask the question through `isPubliclyVisible`.** A `select`
comparing `status === 'PUBLISHED'` is now wrong in a way that leaks: it would
show a rejected listing. 2.10's public projection and Phase 3's search are the
two places this will matter, and both are unwritten, which is the right moment
for this decision.

**Two fields is more state to render.** The owner's page has to explain a listing
that is published and invisible, which is a genuinely confusing thing to be told
and is why 2.8c-ii exists as its own slice rather than as an afterthought here.

**It costs a migration**, where more enum values would have cost none.

## Alternatives considered

**More values in `listings.status`.** Rejected, and it is the option the earlier
comments assumed. It reads simpler and one query answers everything — but it
conflates two authorities into one field, and the cost lands at exactly the wrong
moment: reinstatement. Restoring a listing from `REJECTED` requires knowing what
it was before, which the field no longer holds because the rejection overwrote
it. The workarounds are worse than the problem: a `previousStatus` column is the
second field this ADR chooses, wearing a disguise and carrying no constraint; and
reading history from the audit log to decide current state would make an
append-only trail load-bearing for behaviour, which ADR 0017 exists to prevent.

**A boolean `isHidden` plus a reason.** Rejected. It cannot distinguish "waiting
to be looked at" from "looked at and refused", and §8.3 names both. Those two
demand opposite things from an owner — wait, or fix and appeal — and a field that
cannot tell them apart guarantees the interface tells somebody the wrong one.

**A separate `listing_moderation` table.** Rejected for now. It is where this goes
if moderation grows a history — several decisions over a listing's life, each
with an author and a timestamp — but today there is exactly one current state and
the audit log already holds the history. A table with one row per listing,
created lazily, would add a join to the visibility check, which is the query
Phase 3 runs most.

**Do nothing in Phase 2 and let Phase 9 build it with the queue.** Rejected
because §14 asks for the status here, and because 2.10's public listing page and
Phase 3's search are about to be written against `isPubliclyVisible`. Adding the
second authority afterwards means revisiting every reader — the exact retrofit
that function was created to avoid.

## What would change this

**Moderation acquiring a history** — appeals, several decisions over time, or a
requirement to show what a listing was flagged for previously. Then the separate
table becomes right, and the column becomes a cached current state or goes away.

**Automated signals arriving in Phase 6.** If a scanner produces scores rather
than decisions, the score belongs with the signal and not here; this field stays
the human-decidable outcome.

**Moderation needing to hold a listing's place in a queue** — a claimed-by, a
due-by. Those are queue concerns, they are Phase 9's, and they do not belong on
the listing row.
