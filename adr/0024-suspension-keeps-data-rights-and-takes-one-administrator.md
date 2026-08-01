# 0024. Suspension takes one administrator, and does not remove data rights

- **Status:** Accepted
- **Date:** 2026-08-01
- **Relates to:** BRD §5.1, §8.1, §8.13, §10, §14 Phase 1; ADR 0018, ADR 0021, ADR 0023

## Context

BRD §14 Phase 1 asks for "account suspension and deletion request skeleton". §8.1 lists suspension beside deletion, export and blocked-user controls. §5.1 assigns it to **Trust & Safety** — a module that does not exist and whose "abuse reports, blocks and suspension controls" land in a later phase.

So Phase 1 wants the _mechanism_, not the policy. This builds the capability in Identity & Access, which owns the account and the guard; Trust & Safety becomes another caller when it arrives.

Two questions had to be settled before any of it could be built, and both were put to the product owner because both are risk-posture calls rather than engineering ones.

## Decision

**Suspending takes one administrator, not two.** ADR 0023 built dual approval and this deliberately does not use it. The selection criterion for §8.13's "selected actions" is **irreversible or privilege-escalating**, not destructive-sounding:

|                | Role change                                 | Suspension                         |
| -------------- | ------------------------------------------- | ---------------------------------- |
| Urgent?        | Never                                       | By nature — it exists to stop harm |
| Reversible?    | The damage is done before you notice        | Completely                         |
| Wrong-way cost | An administrator with powers nobody granted | Somebody locked out for a while    |

A control that cannot act quickly is not a safety control. And gating it behind two administrators would make suspension **unusable until two exist** — leaving the platform's only protective measure offline for exactly as long as it is most thinly staffed.

Every suspension still carries a mandatory reason, is audited, and is visible to the person it happened to. If abuse of the capability ever becomes the concern, dual approval is now a mechanism that exists: moving suspension behind it is a variant in `ApprovableAction` and a branch in the executor.

**A suspended person keeps their data-protection rights.** They can sign in, read their own account, profile and activity, download an export and delete the account. **UK GDPR access and erasure rights do not lapse because somebody was suspended**, and an account that cannot authenticate cannot exercise them — so refusing the session outright, the way a deleted account is refused, would be a legal exposure dressed as a security measure.

**The guard is default-deny with a named allowlist.** A suspended account is refused every route unless it carries `@AllowsSuspended()`. The opposite scheme — allow by default, deny with a decorator — fails by leaving a suspended person able to act, which is the entire thing suspension prevents. This way a route added in Phase 2 is closed to suspended accounts by forgetting nothing.

**403, not 401.** The session is valid and signing in again cannot help. 401 would send somebody round a loop that does not end. A _deleted_ account still gets 401, because there the session genuinely is dead.

**A suspended administrator loses the admin surface**, because no admin route opts in. Somebody under investigation must not be able to lift their own suspension. It follows that `countAdministrators()` excludes suspended administrators as well as deleted ones — both hold the role and neither can use it, so counting them would let ADR 0023's last-administrator rule be satisfied by somebody who cannot act.

**The reason is shown to the suspended person, verbatim.** The same bargain ADR 0021 struck for administrative reads: whoever writes it knows who will read it. It means a suspension reason has to be something you would be willing to say to the person's face, which is the right constraint on it.

**Suspension reaches the public profile through a port that already existed.** `findActiveById` now answers null for a suspended account, and Profiles & Trust — which asks that question already — stops publishing them without learning the word "suspension".

## Alternatives rejected

**Put suspension behind dual approval, like role changes.** The strictest reading of §8.13 and what an earlier note in this repository predicted would happen. Rejected on the urgency and reversibility asymmetry above, and because it would leave suspension unusable until a second administrator exists.

**Suspend alone, but require two to reinstate.** Optimises for acting fast on harm while making it harder to quietly undo a colleague's decision. Genuinely attractive. Rejected because it makes correcting your own mistake the slow path, and a wrong suspension is the failure most likely to need undoing quickly.

**Refuse a suspended session outright, like a deleted one.** Much simpler — one branch in the guard, no allowlist, no decorator. Rejected: the person is never told why, and it blocks rights that suspension does not remove. Simplicity bought at the cost of a data-protection exposure is not simplicity.

**A `status` enum on `users` covering active, suspended and deleted.** Tidier than three nullable columns. Rejected for the reason `users` has no status column already: deletion is _two_ timestamps that deliberately diverge (`deletedAt` and `deletionRequestedAt`), and suspension needs a time, an actor and a reason. A single enum cannot hold any of that, so it would end up beside the columns rather than replacing them.

**Store the suspension reason only in the audit log.** No new column, one place for the text. Rejected: rendering the account page would mean identity reading the audit trail to find the most recent suspension entry, which is a query built on a convention rather than a fact, and it breaks the moment an entry is written differently.

**A separate person-facing message, distinct from the recorded reason.** More careful — an investigative note is not always something to hand over. Rejected for Phase 1: two fields means two things to write and one of them will be left empty, and the discipline of writing one reason you would say out loud is more valuable than the flexibility. Trust & Safety can introduce an investigative hold later if it genuinely needs one.

## Consequences

**Nothing writes `account.suspended` yet.** The audit vocabulary exists and the activity page renders it, but suspension is set directly in the database until slice 1.10b adds the routes — the same escape hatch role assignment used before ADR 0023. The action is in the union now rather than with its writer, because an action added at the same moment as its writer is one nobody reviews.

**The `CHECK` constraint covers the timestamp and the reason, not the actor.** The first draft included `suspendedById` and was wrong: `ON DELETE SET NULL` nulls that column when the suspending administrator is removed, which would then violate an all-three-or-none constraint and make the delete fail — turning "we lost the actor" into "you cannot remove this account", the exact outcome `SET NULL` was chosen to avoid. **Found by a database test, and only a database test could have found it.** The audit trail holds the actor permanently, so the suspension survives with an unknown one.

**Rolling this migration back fails open.** A previous release does not read these columns, so every suspended account becomes unsuspended. Worth knowing before rolling back during an incident: if a suspension is holding back an active abuser, the rollback releases them.

**A suspended person can still delete their account, and deletion erases.** Somebody suspended for abuse can therefore remove their profile and address. That is correct — erasure is a right, not a privilege — and it is not evidence destruction: the audit trail is retained for six years under §10.1 and holds digests rather than values (ADR 0017), and the tombstoned account row survives.

**Suspension is invisible to other users beyond the profile disappearing.** No badge, no "this account is suspended" on a public page. Publishing an accusation about somebody is a different decision with defamation exposure attached, and it is Trust & Safety's to make, not this slice's.
