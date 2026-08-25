# 0053. The admin second factor is a port, and the escape hatch is an adapter

- **Status:** Accepted
- **Date:** 2026-08-25
- **Supersedes:** [ADR 0030](0030-a-development-escape-hatch-for-the-admin-second-factor.md)
- **Relates to:** BRD §8.1, §8.13, §9, §10.2, §14 Phase 1; ADR 0015, ADR 0017, ADR 0021, ADR 0050

## Context

[ADR 0021](0021-admin-access-requires-a-second-factor-and-a-reason.md) requires a
second factor verified within twelve hours for administrative access, and its
load-bearing property is that an **unprovable** factor fails closed: "we cannot
tell" reads as "not verified", never as "not required".

Until now exactly one thing could prove it — Clerk's `fva` claim — so the rule
lived inline in `AuthGuard`. Clerk gates every MFA strategy behind its Pro plan
at $25/month, so on the plan this project is on **no second factor can be
enrolled at all**, and ADR 0030 added `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA` as a
development-only branch around the check. ADR 0030 said that flag should be
deleted the day a real second factor existed, and named buying Clerk Pro as the
event that would do it.

That event is not going to happen, and something better has: since 24 August the
platform sits behind Cloudflare, and **Cloudflare Access can enforce a second
factor at the edge on the Free plan.** The dashboard was checked rather than the
documentation trusted — Cloudflare's own docs and blog contradict each other
about whether Independent MFA is generally available — and the account carries a
live "Allow multi-factor authentication (MFA)" section offering TOTP, security
key, biometrics, PIV and FIDO2, independent of any identity provider.

**This does not port the `fva` pattern, and the research is why.** The Access
JWT carries no `amr` claim and no "factor verified at" timestamp; `iat` is the
only freshness signal in it. But the pattern does not need porting, because
Access works the other way round from Clerk: **Clerk admits everyone and lets you
inspect how they authenticated, whereas Access refuses to mint a token at all
unless its policy passed.** A valid assertion for our application audience _is_
the proof. The check moves from our code into the Access policy.

Two consequences of that were found by looking rather than reasoning, and both
would have been invisible:

- **The twelve-hour rule maps to the _global_ session duration, not the
  application one.** An application token silently auto-renews from a still-valid
  global session, so a twelve-hour application session behind a one-month global
  session would look enforced and re-verify nothing.
- **Access protects a public hostname and does nothing for `localhost`.**
  Deleting `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA` as `docs/SECURITY.md` planned
  would mean no admin page ever opens on a developer machine again — returning
  the project to precisely the state ADR 0030 was written to end, in which four
  consecutive slices shipped an administrative surface no human had ever
  operated.

## Decision

**`AdminSecondFactor` is a port, asked through a chain, and `AuthGuard` contains
no bypass at all.**

- **The guard asks and refuses.** `requireSecondFactor` calls the chain and
  throws when the answer is null. The one method that must never be able to say
  "no credential needed" no longer has a branch that says it.
- **The chain short-circuits on the first prover that proves _within_ the age
  bound**, not the first that answers at all. A prover answering with a stale age
  must not stop a later one answering with a fresh age, or a Clerk session
  verified twenty hours ago would mask an Access assertion from five minutes ago
  and refuse somebody who had just presented a security key. That is why
  `MAX_SECOND_FACTOR_AGE_MINUTES` moved to the port's file: the freshness rule
  has to be known where the provers are asked.
- **A prover that throws is unproven, not an error.** Verifying an Access
  assertion involves a key set fetched over the network and rotated every six
  weeks. A Cloudflare outage must degrade to a refusal with a log line, never to
  a 500 on every admin request — fail closed, and say so where it can be read.
- **Order is the escape hatch's safety property, now structural.** ADR 0030
  required the bypass to be consulted only _after_ the real check had failed, so
  that on the day it is wrongly enabled the rule it replaces has still been
  evaluated and logged. Short-circuiting gives that for free, provided the
  development adapter is last. **`composeSecondFactor` exists so that this is
  tested rather than asserted** — it was four lines in `main.ts` until a review
  observed that the ordering was a property of an array literal no test
  constructs, so reordering it would have left the entire suite green while
  discarding the guarantee.

**`DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA` is relocated, not deleted, and
`docs/SECURITY.md` was wrong to plan its deletion.** It becomes
`DevelopmentSecondFactor`, an adapter that is simply not added to the chain when
the flag is off. Every requirement ADR 0030 placed on it survives:
`loadIdentityEnv` still refuses to load the flag under `NODE_ENV=production` so
the process exits before Nest is constructed; it still removes the second factor
and nothing else; it still announces itself at startup, on every request it
admits, and on every admin page.

**One thing about the announcement did change, and it is a loss.** The old
in-guard line named the _platform_ `users.id` and the age the real check had
seen; the adapter names the **Clerk** user id and the variable, because
`SecondFactorEvidence` deliberately carries the session rather than the mirrored
user — a prover has no business holding a database row. So correlating an
admitted-under-bypass request with `audit_logs`, which is keyed on `users.id`,
now needs a join through the mirror, and the admitted line no longer says
whether the real factor was _absent_ or merely _stale_ (a refusal still does,
in `attempts`). Accepted rather than fixed: widening the port to carry a
mirrored user so one development-only adapter can log better is the wrong
trade.

**The banner is derived from the chain rather than from a second reading of the
environment.** `/me` reports `adminMfaBypassed`, and `app.module.ts` computes it
from whether any installed prover declares that it bypasses. ADR 0030 refused to
let the web app hold a flag of its own because two sources answering "what is
configured" and "what is enforced" disagree exactly when it matters; deriving it
from the provers removes the second source entirely rather than merely keeping it
honest.

**Cloudflare Access will be scoped to a path, not a hostname.** The application
covers `staging.renttest123.com/admin*`. Protecting the whole hostname would wall
off the public pages a beta tester needs; using a separate admin hostname would
leave `/admin` reachable unprotected on the main one.

## Alternatives rejected

**Key the override on `APP_ENV` and trust that Access happened.** Offered to the
product owner as the cheap H8 and refused on the merits. It **inverts ADR 0021's
failure mode**: delete one Access rule and the admin surface opens silently to
anyone holding the role, with nothing in the request proving Access was ever
involved. A cryptographic assertion that Cloudflare admitted _this_ request for
_this_ application is a materially different claim from an environment variable.

**Read `amr` from `/cdn-cgi/access/get-identity`.** It genuinely carries the
authentication method. Rejected because it is a network call _per admin request_
inside an authentication path, and because the claim depends on the identity
provider choosing to share it — Cloudflare names only Okta and Entra ID, neither
of which we use. The structural argument gives the same guarantee with no
request.

**Require MFA through an `auth_method` policy rule.** The documented way to
require a specific factor. Unavailable to us: it needs Okta, Entra ID, generic
OIDC or generic SAML, and social identity providers are not on that list.
Independent MFA is what makes this work on the Free plan.

**One-time PIN as the second factor.** Available on Free and tempting. Rejected
because it is email possession — a _single_ factor — and Cloudflare's own docs
describe it as an alternative to configuring an identity provider, never as MFA.
Building on it would have been authentication theatre, and worse than what exists
because it would have looked like a control.

**Buy Clerk Pro.** Still the tidiest answer on the merits and still $25/month for
one feature, on a project with no budget. Nothing here argues against it; if it
is ever bought, the Clerk adapter is already the first prover in the chain and
starts working with no code change.

**Build TOTP into the API ourselves.** Would work everywhere including
`localhost`, and would delete the development adapter honestly. Rejected because
it puts a credential in our database, which cuts directly against ADR 0015's
central decision that Clerk holds credentials and `users` is a mirror — and
because rolling an authentication factor is a poor use of a two-person team when
an identity provider will do it at the edge for nothing.

**Delete the development adapter and accept that admin pages need staging.**
Considered seriously, because a development-only relaxation of a security check
is exactly what ADR 0030 warned against accumulating. Rejected because the cost
is known and was already paid once: four slices shipped to a surface nobody could
open, and every defect class this project keeps finding is the kind only found by
using a page.

## Consequences

**The strength of the control now lives partly in Cloudflare configuration,
which is not in version control.** Our code can prove Access admitted the
request; it cannot prove _which factors_ the policy required. Somebody weakening
the Access policy weakens the second factor and nothing in this repository will
notice. That is the same class of dependency as ADR 0015's Clerk provisioning
list, where every item fails silently if missed, and it is recorded in
`docs/SECURITY.md` for the same reason.

**The global session duration is now load-bearing configuration**, and it is
currently set to "Same as application session timeout" — which is the trap
described above. Bounding it is part of slice H8b, not an optional tidy-up.

**A network call enters the authentication path for the first time.** The Clerk
verifier's justification for declaring no timeout — that it performs no I/O — is
a property of that adapter and cannot be copied to the Access one, which must
state a real timeout under BRD §5. The chain's fail-closed catch is what stops
that becoming an outage.

**ADR 0030's removal condition is discharged differently than it expected.** It
said "Clerk Pro being bought deletes this". Clerk Pro is not being bought, the
flag survives, and what changed is that it is no longer a branch inside the
guard. Anyone reading 0030 alone would conclude the flag should be gone; it is
not, and this document is why.

**`DevelopmentSecondFactor` is still a development-only relaxation of a security
check, and 0030's warning still applies.** It said not to add a _second_ one
beside the first. This is the first one relocated, not a second one — and that
distinction is worth defending the next time somebody proposes an adapter that
makes a check easier to satisfy.

## What would change this

If Clerk Pro is ever bought, nothing needs building: the Clerk adapter is already
first in the chain, and `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA` can then be deleted
outright — which is finally the deletion ADR 0030 asked for, with the development
adapter going with it.

If a shared non-production environment is ever stood up, tighten the flag's
refusal from `NODE_ENV === 'production'` to an allowlist of exactly `development`
and `test`, as ADR 0030 already proposed.

If a third prover is ever added, look hard at whether it belongs in the chain or
whether the chain has become a place where anything that says yes is enough. Two
provers that can each independently satisfy a control is a design; five is a
posture.
