# 0030. Give the admin second-factor check a development escape hatch that cannot reach production

> **SUPERSEDED by [ADR 0053](0053-the-admin-second-factor-is-a-port-and-the-escape-hatch-is-an-adapter.md),
> 25 August 2026.** The flag still exists and still cannot reach production, but
> it is no longer a branch inside `AuthGuard` — it is an adapter behind the
> `AdminSecondFactor` port, and the guard now contains no bypass at all. **Read
> 0053 before concluding from this document that the flag should have been
> deleted**: its removal condition named buying Clerk Pro, which did not happen.
> Cloudflare Access supplies the real second factor instead, and Access cannot
> reach `localhost`, so the development adapter survives.

- **Status:** Superseded by ADR 0053
- **Date:** 2026-08-04
- **Relates to:** BRD §9, §10.1, §14 Phase 1; ADR 0015, ADR 0021

## Context

ADR 0021 requires a verified second factor, no more than twelve hours old, for
every administrative action, and reads Clerk's `fva` claim to prove it. It fails
closed: an absent claim reads as "not verified", because the alternative would
turn a missing piece of instance configuration into an open admin surface on a
correctly-signed token.

On 4 August 2026 it turned out that **Clerk gates every MFA strategy — and
passkeys — behind its Pro plan, at $25/month**. There is no free second factor of
any kind. Clerk emits `fva: -1` for an account that has none, the guard reads
that as unverified, and therefore **no admin page can be opened by anybody, in
any environment, on the plan this project is on**. The product owner decided to
defer the cost to the pilot.

The consequence arrived faster than expected. By the end of slice 2.4b, **four
consecutive slices had shipped an administrative surface no human had ever
used** — the category editor, the attribute schema editor, the
reportable-activity flag and its statutory confirmation that counsel has
determined our reporting scope. Every one of them is evidenced by tests alone.

That matters here more than it would elsewhere, because of what the tests keep
missing. Sessions 19 through 25 each found a defect by _using_ a page under a
fully green suite: a page whose refusal was correct with an enabled form beneath
it; a link to a device list that opened a list of email addresses; a form that
threw the moment its button was pressed, on the account-deletion route BRD §10.1
requires; an error message rendered above the fold, which made a working form
look inert. **A test can only assert the intent you already had.** A surface
nobody can operate is one where that entire class of defect accumulates
undetected until the day somebody real tries it.

The engineering recommendation on 4 August was a development-only override. The
product owner declined it that day and reversed the decision the same day, once
the accumulated cost was visible.

## Decision

**`DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA` admits an administrator with no verified
second factor, and it cannot be set anywhere real.**

- **Absent or anything other than the exact string `true`, nothing changes.**
  Not `z.coerce.boolean()`, which reads every non-empty string as true —
  including `"false"`, `"0"` and `"no"`. For a flag that removes an
  authentication check, the reading of `=false` must be _off_.
- **With `NODE_ENV=production`, the process refuses to start.** It is not
  ignored, not overridden and not warned about. `loadIdentityEnv` fails
  validation and the API exits naming the variable. A flag that is silently
  dropped in production is one somebody eventually believes is working.
- **The bypass is consulted only after the real check has already failed.** The
  ordinary path still runs and still logs; the flag changes what happens next
  and never what is evaluated. A bypass tested first would mean that on the day
  it is wrongly true, nothing had ever exercised the rule it replaces.
- **It removes the second factor and nothing else.** The role check, the
  suspension check and session verification are untouched, and tests pin each of
  those still refusing while the flag is on.
- **It announces itself three times**: a `warn` at startup on every boot, a
  `warn` on every request it admits — naming the variable, so a search finds the
  requests rather than only the banner — and a notice on every administrative
  page.

**The page banner is served from the API, not decided by the web app.** `/me`
reports `adminMfaBypassed`, and the admin layout renders the warning from it.
The web app holds no flag of its own: two flags would be two sources that can
disagree, and they would disagree exactly when it matters, because they answer
different questions — what is configured, and what is being enforced.

**The banner lives in `apps/web/src/app/admin/layout.tsx`,** so no admin page can
be added without it. Same reasoning the guard uses for folding MFA into the role
check rather than a per-route decorator: a rule you have to remember to apply is
one that eventually is not.

## Consequences

**ADR 0021 is not superseded and its rule is unchanged.** In every environment
that matters, administrative access still requires a second factor verified
within twelve hours. This ADR adds an exception that provably cannot apply
outside local development, and it should be read as scaffolding with a removal
date rather than as a revision of the rule.

**Anything learned by using an admin page while this is on is knowledge about
the page, not about the authentication in front of it.** That is the whole
reason for the banner, and a handoff note claiming an admin surface was
"verified by use" has to say which regime it was verified under. The value is
still large — the four slices above have never had their forms submitted once —
but it is bounded, and the boundary is easy to forget.

**The API now reads `NODE_ENV` in two loaders.** `loadEnv` and `loadIdentityEnv`
both take it. That is not a second source of truth: the identity schema needs it
to decide whether its _own_ field is valid, which is a judgement it cannot make
without knowing where it is running.

**`/me` grows a field that is not about the user.** It is the only response every
authenticated page already reads, so it is the cheapest honest place to put it,
and it is defaulted to `false` so an older API stays parseable during a deploy
skew. If more of these appear, they want their own endpoint rather than a
growing `/me`.

**It must be removed when Clerk Pro is bought.** BRD §9 makes step-up
authentication mandatory for administrative actions, and this defers a cost
rather than removing one. Buy Pro at slice 0.9b or Phase 11 entry, whichever
comes first — and delete this flag in the same change, rather than leaving a
disabled security check in the tree for somebody to find and wonder about.

## Alternatives considered

**Pay the $25/month now.** The correct answer on the merits, and the product
owner's call to defer. Nothing here argues against it; the flag exists because
the decision was to wait, and it is written so that buying Pro deletes it rather
than complicating it.

**Weaken ADR 0021 to treat an absent `fva` claim as satisfied.** The obvious
one-line change and by far the most dangerous. It would apply everywhere,
permanently, with no way to tell a free-plan development instance from a
production instance that was provisioned without the claim — which is precisely
the failure ADR 0021's fail-closed reading exists to prevent. A one-line
"temporary" relaxation of an authentication rule is the kind of thing that
survives to launch.

**Comment out the check during development.** Same effect, no audit trail, and it
either gets committed or it does not — one being a landmine and the other being
a change nobody can review. A configuration flag is at least visible in a diff, in
a log line and on the page.

**A separate build or a `NODE_ENV`-only condition with no flag**, so development
always bypasses. Rejected because it removes the ability to test the _enforced_
path locally, and because "development" is a broad word — a shared demo
environment running with `NODE_ENV=development` would silently be wide open. The
flag has to be typed deliberately.

**Seed a second-factor claim into a fake verifier for local use.** Would keep the
guard untouched, and it means running the local web app against a fake identity
provider — so what gets exercised is no longer the real Clerk token path, which
is a large part of what opening the page is meant to prove.

**Grant the override per-session through an admin action.** More precise and
needs an administrator to enable it, which is the problem: no administrator can
reach an admin action, which is what this exists to fix.

## What would change this

**Clerk Pro being bought deletes this.** Remove the variable, the token, the
guard branch, the `/me` field and the layout banner together — a bypass left in
the tree after its reason has gone is worse than one that never existed, because
the next reader has to work out whether it is still needed.

If a shared, non-production environment is ever stood up for demonstrations,
tighten the refusal from `NODE_ENV === 'production'` to an allowlist of exactly
`development` and `test`. It is one line, and the reason it is not written that
way today is that `NODE_ENV` has only three values in this codebase and the
schema already enumerates them.

If a second development-only relaxation is ever proposed, do not add it beside
this one. Two is a pattern, and a pattern of security checks with escape hatches
is a posture rather than an exception.
