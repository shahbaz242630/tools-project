# 0023. Require two administrators to change a role

- **Status:** Accepted
- **Date:** 2026-08-01
- **Relates to:** BRD §8.13, §17 risk table, §14 Phase 1; ADR 0004, ADR 0021, ADR 0022

## Context

BRD §8.13 asks for two things, and slice 1.8a only built the first:

> High-risk actions require step-up authentication and, **for selected actions, dual approval**.

§17's risk table names dual approval as a mitigation for _admin misuse_, beside least privilege, MFA and immutable audit logs.

Two facts shaped when to build it. First, **every administrative capability up to now was a read** — activity (1.8a) and the account view (1.8b-ii). Second, ADR 0021 recorded that role assignment had no route at all, and said why:

> Granting the role has no route. Roles are set directly in the database for now, because role assignment is itself an administrative action needing its own route, reason and audit entry — and adding it to the production port now would create an ungoverned way to do it.

ADR 0022 then said dual approval should arrive **before** the first destructive capability, "because retrofitting approval onto an action people already use is much harder than building it in".

Dual approval also cannot be built alone. A mechanism with no registered action is either an abstraction with zero implementations or a form with an empty dropdown, and CLAUDE.md bans dead controls. It needs a first action, and role assignment is the one where a single administrator acting alone is worst: it is privilege escalation, and an administrator who can grant themselves anything makes every other control in this codebase decorative.

## Decision

**Changing an account's role takes two administrators.** One proposes with a reason; a _different_ one agrees with a reason; the role changes. Both are recorded, and the account holder can read both on their own activity page.

**The rule is enforced in three places, and that is not redundancy for its own sake.** The service refuses a proposer approving their own; the store's conditional claim excludes them too; and a Postgres `CHECK` constraint refuses the row outright. The database layer is the guarantee — the same reasoning as the booking overlap constraint (ADR 0004): a rule that lives only in application code is a rule the next code path forgets, and the cost of forgetting _this_ one is one administrator granting themselves whatever they like. The layers above exist so the refusal reaches the caller as a clean 409 rather than a constraint violation surfacing as a 500.

**Approval and execution are one transaction, with no separate "executed" timestamp.** A decision recorded without its effect is a lie in a record kept for audit; an effect applied without its decision is exactly the unapproved administrative action the table exists to prevent. Inside a transaction, a failure to apply rolls the approval back and leaves the proposal pending and retryable — which is what happens if the target account is deleted between proposal and approval.

**Proposals expire after 24 hours.** An approval sitting for a month is agreed against circumstances nobody remembers, and a stale queue is one people clear rather than read. The window is elapsed time, not calendar days: `Time.addHours` was added for exactly this distinction, because a deadline must not move because the clocks did (contrast ADR 0003's rental days, which must).

**A change may not reduce the administrator count to zero.** Demote the last administrator and there is nobody left to promote anybody — and no route that could, because role assignment _is_ this mechanism and it needs two administrators to work at all. Recovery would be a database write on a production box. Checked at proposal and **again at approval**, because a day may pass and the other administrator may have stepped down in between.

**Anyone may cancel, including the proposer.** Withdrawing your own request causes no effect, and dual approval is about causing one.

**A lookup that finds nothing is still recorded**, and a refused proposal is never deleted. What administrators _tried_ to do is most of the point of keeping the table.

**`admin.approval_proposed` is recorded against the target**, not the proposer, so the person whose role somebody proposed changing sees it on their own activity page — the same control ADR 0021's correction established for administrative reads.

**The ledger lives in `identity/`, not its own module.** Its only action is an identity action, and putting it elsewhere would mean a transaction spanning two modules' stores through ports that expose no transaction handle. The first approvable action _outside_ Identity & Access — a listing takedown, a payout reversal — is what should force the extraction, and by then there will be two implementations to generalise from rather than none.

## Alternatives rejected

**Build the approval mechanism generically first, with no registered action.** Tidier sequencing, and it would let suspension and role assignment both land later as mere registrations. Rejected twice over: an abstraction with zero implementations is how the wrong abstraction gets built, and the page would be a form with an empty dropdown, which CLAUDE.md bans as a dead control.

**Guard account suspension first instead.** It is on the §14 Phase 1 list where role assignment is not. Rejected because it is a bigger slice — a new column, new guard semantics for a suspended session, user-facing messaging and a reversal path — and because doing role assignment first means the power to _create_ an administrator is already two-person controlled by the time suspension exists.

**Keep role assignment as a database write and skip the route.** No new attack surface at all, which is genuinely the safest option. Rejected because it is not actually safer in practice: it means every promotion is an unaudited manual `UPDATE` by whoever holds the production credentials, which is a worse version of the thing dual approval prevents, performed without a reason, a second pair of eyes or a record.

**Approve now, execute later, as two steps.** Would allow a scheduled or queued effect. Rejected: it creates a window in which a decision is recorded but not applied, and somebody has to reconcile that window forever. Nothing here needs to be asynchronous.

**A `state` column instead of derived state.** Easier to query and index. Rejected for the reason `users` has no `status` column either: a state column is a second thing to keep true alongside the timestamps that already say everything, and the two disagree the first time a write is partial. `approvalState()` derives it in one place, and the CHECK constraints keep the timestamps consistent.

**Let the proposer approve when they are the only administrator.** Charitable to a single-administrator deployment, which is exactly what this platform has today. Rejected, and this is the one worth being firm about: a bypass that activates precisely when oversight is impossible is not a bypass, it is the absence of the control. The single administrator is a _fact to fix_, not a case to special-case.

**Block any change reducing the count below two, rather than below one.** Would prevent the platform ever getting stuck with one administrator unable to approve anything. Rejected as too strict: with exactly two administrators, neither could ever be demoted without promoting a third first, which turns an ordinary personnel change into a puzzle. Going from two to one is legitimate; it just has a consequence, stated below.

## Consequences

**With one administrator, nothing can be approved.** That is today's reality: the product owner is the only administrator, so the first proposal will sit pending until a second administrator exists. **Creating that second one is a database write** — the same escape hatch role assignment has always used, deliberately kept outside the application, because any in-application route to a first administrator is a route round the rule. This is a product-owner task, and the approvals page says so in plain words rather than letting somebody discover it by pressing a button.

**Going from two administrators to one leaves the platform unable to approve anything** until a third is added by hand. Legitimate but worth knowing before doing it. The last-administrator rule stops the _total_ lockout; it does not stop this one.

**The admin surface now has three pages and no index.** Cross-links were enough at two. At three they are borderline, and at four they will not be.

**This is the first place before/after state exists on an admin action.** §8.13 asks for "actor, reason, target and before/after state" on every one; until now every admin action was a read and had no state change. `admin.approval_granted` carries differing digests, which is the requirement met for the first time rather than deferred again.

**`AdminApprovalStore.approveAndApply` knows what it is applying.** The switch over `ApprovableAction` lives in the Prisma adapter, because that is where the transaction is. Adding suspension means a variant in the union and a branch there — deliberately small, and the test of whether this mechanism was worth building.

**A fourth in-memory double now mirrors a database constraint.** `InMemoryAdminApprovalStore` enforces the two-person and single-outcome rules because Postgres does. That defect — a double enforcing less than the real thing — has now appeared twice in this codebase (slices 1.7 and 1.8b-i), and here the rule being mirrored is the one the whole mechanism exists for.
