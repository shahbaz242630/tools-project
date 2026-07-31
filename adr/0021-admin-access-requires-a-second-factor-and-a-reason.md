# 0021. Require a second factor and a stated reason for administrative access

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates to:** BRD §8.1, §8.13, §14 Phase 1, §17 risk table; ADR 0015, ADR 0017

## Context

BRD §14 Phase 1 asks for an "admin role with MFA requirement" and a read-only "view as user" with audit logging. §8.1 says "MFA required for administrators". §8.13 adds two things that are easy to skim past:

> High-risk actions require step-up authentication and, for selected actions, dual approval.
>
> **Every admin action records actor, reason, target and before/after state.**

A **reason** — not merely who did what to whom, but why. The audit log built in slice 1.5a records actor, action, target and digests. It had no reason, because no action so far needed one: somebody editing their own profile owes nobody an explanation.

The `ADMIN` role and a `@Roles` decorator have existed since slice 1.2 and nothing used them.

## Decision

**MFA is enforced at the guard, for the role, not per route.** Any route requiring `ADMIN` also requires a second factor verified within `MAX_SECOND_FACTOR_AGE_MINUTES`. §8.1 requires MFA _of administrators_ rather than of particular actions, and folding it into the role check means an admin route cannot be added without it by forgetting a decorator — the same reasoning that already makes an absent `@Roles` mean "authenticated" rather than "anyone".

**An unprovable second factor is refused.** The state comes from Clerk's `fva` claim — factor verification age, `[first, second]` in minutes, `-1` for not verified. `secondFactorAge` reads _anything unexpected_ as null: an absent claim, a wrong shape, a negative age. Null fails the check.

This is the load-bearing decision. **An instance provisioned without the claim emits correctly-signed tokens carrying no proof of a second factor.** Treating that as satisfied would turn a missing piece of instance configuration into an open admin surface, silently, on tokens that verify perfectly. The only safe reading of "we cannot tell" is "not verified".

It also means the claim joins the `email` claim as **instance configuration this API depends on** — see the provisioning list in ADR 0015, now updated.

**Twelve hours is the maximum age.** An engineering bound on how long a privileged session stays privileged, not a business rule; §8.13 asks for step-up authentication without naming a number. It keeps a support shift working without leaving a forgotten browser tab administratively capable overnight.

**`audit_logs.reason` is nullable, and the requirement is enforced by the admin routes.** A `NOT NULL` would force every ordinary user action to invent a reason, which is how a mandatory field becomes a meaningless one. The distinction the BRD draws is between admin actions and everything else, so that is where the rule lives.

**The reason has a minimum length and is visible to the subject.** Twelve characters does not judge quality — nothing stops somebody typing nonsense — but it stops an empty box being submitted by habit. What actually makes it a control is that **the person whose account was read can see it** on their own activity page. An administrator typing a reason knows, at that moment, who will read it.

**The first administrative capability is a read, and it is itself audited.** `GET /admin/users/:userId/activity` records `admin.activity_viewed` with the reason **before** performing the read, so a disclosure cannot happen without the record of it — the same ordering as the export (ADR 0019). §8.13 permits read-only support access from Phase 1 and prohibits write-capable impersonation at launch.

**The admin page does not check the role.** The API does, on every request, with the second factor. A check in the page would be a second place for the rule to live and the easier of the two to get wrong, and hiding a form from an ordinary user protects nothing when the endpoint holds the data.

**Granting the role has no route.** Roles are set directly in the database for now. The test double has a `promote` helper that is deliberately _not_ on `UserDirectory`, because role assignment is itself an administrative action needing its own route, reason and audit entry — and adding it to the production port now would create an ungoverned way to do it.

## Alternatives rejected

**A separate `@RequiresMfa()` decorator beside `@Roles('ADMIN')`.** More explicit, and it would allow MFA on non-admin routes later. Rejected because it can be forgotten, and the failure mode of forgetting it is an unprotected admin route. Coupling them makes the safe thing automatic; a separate step-up decorator can still be added later for high-risk actions, which is a _stricter_ requirement rather than the baseline.

**Treat an absent `fva` claim as "MFA not required by this instance".** Charitable to a partially configured environment, and catastrophic. It makes a configuration omission indistinguishable from a satisfied control.

**Check MFA in the session verifier and reject the token outright.** Would fail earlier. Rejected because an administrator without a second factor is still a valid _user_ — they should be able to read their own profile. Only the admin surface is closed to them.

**A `NOT NULL` reason column.** Symmetric and self-enforcing. Rejected: every user action would need a placeholder, and a column full of `"user action"` teaches a reader to ignore the field entirely.

**Free-text reason with no minimum.** Trusts administrators, who are trusted. Rejected because the failure is not malice but habit — an empty box cleared without thought — and a minimum makes the pause deliberate.

**Hide the admin page from non-administrators.** Tidier. Rejected: it duplicates an authorisation rule into a place where getting it wrong is invisible, and it protects nothing, because the data is behind the API.

## Consequences

**An administrator without a verified second factor is locked out of the admin surface**, including — the awkward case — the administrator who would fix the configuration. Recovery is at Clerk, by enabling MFA on that account, not in this codebase. That is the correct direction of dependency and it should be part of provisioning a new instance rather than discovered during an incident.

**The claim is now load-bearing instance configuration**, alongside the `email` claim. An instance missing it produces an application where nobody can be an administrator, which fails safe but is confusing without this note. ADR 0015's provisioning list carries it.

**Twelve hours is a guess.** It is one constant in one file, and it should be revisited when there is an actual support process to size it against.

**Read-only "view as user" is not built.** §8.13 asks for it in Phase 1 and this slice deliberately stops short — it needs the admin role and MFA to exist first, which is what this provides. It is the next slice.

**Dual approval is not built.** §8.13 asks for it on "selected actions", and none of the actions that would need it exist yet. Worth remembering before the first destructive admin capability lands, because retrofitting approval onto an action people already use is much harder than building it in.

**Nothing records before/after state for admin actions yet**, beyond the digests every entry already carries. §8.13 asks for it; a read has no state change, so the requirement first bites on the first admin _write_, which does not exist.
