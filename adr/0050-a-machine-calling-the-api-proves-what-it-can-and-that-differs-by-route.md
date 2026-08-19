# 0050. A machine calling the API proves what it can, and that differs by route — with the rule Phase 5's payment webhooks must follow

- **Status:** Accepted
- **Date:** 2026-08-19
- **Relates to:** BRD §5.1, §10.1, §10.2, §14 Phase 5; ADR 0015, ADR 0017, ADR 0021, ADR 0037, ADR 0048
- **Decided by:** engineering, during the pre-Phase-5 audit. Written because the audit found two `/internal/` routes with different controls and two files arguing opposite cases, neither citing the other.

## Context

Two routes on the API are called by a machine rather than a person, and they are
protected differently.

| Route                                     | What it can do                                 | Control today                                            |
| ----------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `POST /internal/bookings/expire-requests` | move overdue `REQUESTED` bookings to `EXPIRED` | shared secret, `timingSafeEqual`, `InternalTriggerGuard` |
| `POST /internal/identity/clerk-events`    | **create, update and delete users**            | network position only                                    |

The more dangerous route has the weaker control, which is what the audit
flagged. Worse, the codebase contains both arguments and they contradict:

- **ADR 0048**, on the expiry route: _"Network position was considered and
  refused as a control… Trusting that would mean an unauthenticated mutating
  route whose only protection is topology — and one compromised container then
  reaches it."_
- **`packages/config/src/web-env.ts`**, on the identity route: verifying at the
  web app _"buys nothing: an attacker who can reach the API internally can
  already reach Postgres beside it."_

Both cannot be right, and the disagreement was invisible because neither
mentions the other. This ADR settles it by writing down the threat model both
were reasoning about informally.

## The threat model, stated once

Six services join the `internal` network. What each already holds decides what a
credential on an internal route could possibly add.

| Container                          | Database credentials | `CLERK_SECRET_KEY` | Can dial the API |
| ---------------------------------- | -------------------- | ------------------ | ---------------- |
| `web`                              | **no**               | **yes**            | yes              |
| `worker`                           | yes                  | no                 | yes              |
| `api`                              | yes                  | no                 | —                |
| `migrations`                       | yes                  | no                 | yes              |
| `redis`                            | no                   | no                 | yes              |
| `postgres` (unused since ADR 0037) | —                    | —                  | yes              |

Two things fall out, and both were missed by the arguments above.

**`web-env.ts` is wrong about `web` specifically, and `web` is the container that
matters.** It has _no_ database credentials — deliberately, and CLAUDE.md says so
— so "can already reach Postgres" is false for exactly the one service an
external attacker reaches first. That objection does not survive.

**ADR 0048's argument does not rescue the identity route either**, because of
what a shared secret can and cannot do. The legitimate caller must hold the
credential, so requiring one never defends against that caller being
compromised. Adding a secret to `/internal/identity/clerk-events` would leave a
compromised `web` able to forge identity events exactly as before, and would only
stop `redis` and `migrations`.

**And a compromised `web` does not need our webhook route at all.** It holds
`CLERK_SECRET_KEY`, which by its own docblock _"can read the whole user
directory"_. An attacker there manipulates identity at Clerk directly; forging
rows in our mirror is the least of it.

## Decision

**1. The identity webhook route keeps network position as its control, and the
reason is now written down rather than asserted.** A shared secret there would
defend only against `redis` and `migrations` — two containers that hold no
credentials and run no code of ours that talks to the API — while leaving the
realistic compromise untouched. That is ceremony, and it would add a **required**
environment variable to the web service, which is not free: a missing
`INTERNAL_TRIGGER_SECRET` froze staging for 31 hours on 18–19 August 2026 with
seven consecutive failed deploys.

**2. The expiry route keeps its shared secret.** ADR 0048 stands unchanged. The
asymmetry is not an oversight and is not to be "tidied" into consistency: the
routes differ because the callers differ. The worker's secret proves the caller
is one of ours in a case where nothing else does; the webhook's signature is
verified one hop upstream by the only process that can see the raw body.

**3. Phase 5's payment webhooks verify the provider's signature _at the API_, not
only at the web app.** This is the part of this ADR that changes future work, and
it is the reason it exists. Every argument above that spares the identity route
rests on `web` already owning identity through `CLERK_SECRET_KEY`. **None of that
transfers to money.** A compromised `web` holds no payment authority today and
must not acquire any, so a forged `payment_intent.succeeded` accepted on the
API's word alone would let the web container mark hires paid, release damage
holds and drive payouts — none of which it can otherwise do.

Concretely, for Phase 5:

- The web route stays a **transport**: it receives the delivery, and forwards the
  **raw body unmodified** together with the provider's signature headers.
- The **API** verifies the signature against the provider's webhook secret and
  refuses anything that fails, before any handler sees it.
- The provider's webhook secret is therefore given to the **API**, not the web
  app. **This does not weaken ADR 0015**, whose rule is about `CLERK_SECRET_KEY`
  — a key that reads the whole user directory. A webhook signing secret verifies
  a signature and grants nothing.
- `webhook_events` already carries `UNIQUE (provider, externalId)`, so
  idempotency needs no new mechanism.

## What was rejected

**Applying `InternalTriggerGuard` to the identity route for consistency.** The
audit's first recommendation, and the analysis above is why it was not taken.
Consistency between two routes is worth something, but not a credential that
defends against neither realistic attacker and one more required variable in the
process whose absence has already cost a day of deploys. Recorded here so the
next reader finds a reason rather than an omission.

**Moving Clerk's signature verification into the API, as Phase 5 will do for
payments.** Correct in principle and rejected on cost: it needs the raw body
forwarded byte-exact, and the failure mode of getting that wrong is every
identity event silently refused. The thing it would protect — our mirror of
Clerk — is already fully exposed to a compromised `web` through Clerk's own API.
Revisit if the web app ever stops holding `CLERK_SECRET_KEY`.

**A second shared secret per caller.** Least privilege in form only: both
containers read the same env file on the same host, so a compromise that yields
one yields the other. It would be two things to rotate and one more way for a
deploy to fail.

## Consequences

**The asymmetry is now intentional and documented, and `web-env.ts`'s claim is
corrected** rather than left to contradict ADR 0048.

**This ADR is a standing instruction to Phase 5, not only a record.** The
payment-webhook rule above is binding, and it is deliberately written before the
slice so it is not decided by whoever copies the Clerk route.

**The threat-model table needs revisiting when a container is added or when what
one holds changes.** It is the whole basis of the decision — in particular, if
`web` ever loses `CLERK_SECRET_KEY`, or gains database credentials, both
conclusions here change.

**Nothing about the identity route changed in code**, so there is nothing to
verify beyond what already runs. The expiry route's control was exercised on
staging on 19 August 2026, the first time it had ever run there: correct secret
returned `{"expired":0,…}`, an absent one and a wrong one each returned 401
logging only `absent` and `mismatch`.
