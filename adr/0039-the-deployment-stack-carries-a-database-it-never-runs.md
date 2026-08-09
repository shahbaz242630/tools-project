# 0039. The deployment stack carries a database it never runs

- **Status:** Accepted
- **Date:** 2026-08-09
- **Relates to:** ADR 0009, ADR 0012, ADR 0037, ADR 0038; BRD §12.4, §14
- **Slice:** 0.9d

## Context

ADR 0037 moved Postgres to Neon. `infra/compose/docker-compose.app.yml` still deployed one, so
this slice removes it from every real environment.

That is straightforward. What is not is the **`Deploy rehearsal` CI job**, which is the only
thing standing between us and a deploy script that quietly stops working. It builds the real
images, writes a real env file, runs `scripts/deploy.mjs` against the real compose file, asserts
that migrations applied by reading the schema, asserts no container publishes a port, then
deploys a second release and rolls back. BRD §14's exit gate asks for rollback and log retrieval
to be demonstrated; this is where that is demonstrated mechanically, on every pull request.

**All of it needs a database.** Deleting the `postgres` service outright leaves three options:

1. Point CI at a real Neon branch.
2. Have CI construct a Postgres of its own, outside the compose file.
3. Weaken what the rehearsal asserts.

Option 1 puts a credential that can reach a real managed database into a job that runs on every
pull request, including from a fork. The `Secrets and dependencies` check exists to stop exactly
that class of thing. It also makes every PR in the repository depend on a third party being up:
a Neon incident would redden branches that have nothing to do with the database, which is the
fastest way to teach a team to ignore a red check.

Option 2 means a container on the app stack's `internal` network but owned by a different compose
project, joined by a network name that is derived from the project name — brittle, and brittle in
a way that fails as a confusing networking error rather than as a clear one. It also means CI is
no longer rehearsing the file that deploys, which is the single property that gives the job its
value.

Option 3 gives up the schema assertions, and those exist because of a real incident: a migration
tool that printed an error and exited zero.

## Decision

**Keep the `postgres` service in `docker-compose.app.yml`, behind a `rehearsal` compose profile,
and make it impossible to reach production by accident.**

- A service with `profiles: ['rehearsal']` is not started, not created and not resolved unless
  something names that profile. The mechanism is already used in this file — `migrations` sits
  behind `profiles: ['migrate']` — so this adds a pattern nobody has to learn.
- **CI sets `COMPOSE_PROFILES: rehearsal` at the job level** and brings the database up itself
  before invoking the deploy, because the application services no longer declare `depends_on` and
  `compose run migrations` would therefore not start it.
- **`scripts/deploy.mjs` refuses to run when that profile is enabled and the target is
  production.** Not filtered out, not warned about — refused, for the reason ADR 0030 gives.
- **CI asserts both directions**: resolving the file with no profiles must yield no `postgres`
  service, and resolving it with the profile must yield one. The first keeps ADR 0037 true; the
  second stops the rehearsal silently degrading into a job that proves nothing.

Two further changes fall out of the database being remote.

**`POSTGRES_HOST` and `POSTGRES_DIRECT_HOST` are separate values.** Prisma holds a Postgres
advisory lock for the duration of a migration so two deploys cannot migrate concurrently.
Advisory locks are session state; a transaction pooler hands out a different backend per
transaction, so through Neon's `-pooler` endpoint the lock is taken and immediately lost. The
migrations service therefore uses the direct endpoint and the applications use the pooled one.
They differ by six characters, which is precisely why neither is derived from the other.

**`depends_on: postgres` is gone from `api`, `worker` and `migrations`.** There is nothing in the
stack to wait for. Gating on a remote database would also mean a Neon blip blocked a redeploy —
exactly when a fix most needs shipping.

## Consequences

**A reader of the compose file will see a database and reasonably conclude the stack deploys
one.** That is the real cost, and it is paid down with a loud comment on the service, a section
in the runbook, and the refusal in `deploy.mjs`. The refusal is the part that matters: comments
are advisory and this is not.

**`COMPOSE_PROFILES` is ambient.** It can be set by a shell profile, an export that outlived its
job, or a copied command line. Without the guard, a production deploy would start a Postgres
container that no application is pointed at, holding a stale schema on a disk nobody backs up —
and **every health check would still pass**, because the applications are talking to Neon
regardless. Nothing would notice, possibly for months. Staging remains permitted, because staging
is what the rehearsal deploys as.

**The rehearsal now proves slightly more than it did.** `POSTGRES_SSLMODE` genuinely differs
between CI (`disable`, a container on a private bridge) and a real environment (`verify-full`,
Neon across the internet), so ADR 0038's field is exercised at two settings rather than assumed.

**There is no `rental-<env>-postgres` container on the box**, so `docker exec … psql` no longer
works and neither does `logs.mjs --service postgres`. Both were in the runbook and in a failure
message inside `deploy.mjs`; all three are corrected here.

**One assertion in the rehearsal still reads the schema over `docker exec`** into the rehearsal
container. That is fine — it is asserting the migrations image did its job — but it means the
rehearsal cannot detect a problem that only appears against a managed endpoint. The first real
deploy is still the first real test, and this ADR does not pretend otherwise.

## Alternatives considered

**A separate `docker-compose.rehearsal.yml` passed with a second `-f`.** Cleanest to read: the
deployment file would contain nothing that must never run. Rejected because `deploy.mjs` takes a
single fixed compose file, so this needs a new flag whose only caller is CI — and a deploy script
with a CI-only code path is weaker evidence that CI is rehearsing the real thing.

**Delete the service and let CI run `docker run postgres` by hand.** Simple, and it loses the
`internal` network, the healthcheck, the init SQL mount and the identical PostGIS pin — every one
of which is part of what makes the rehearsal resemble a deployment.

**A real Neon branch per pull request.** Genuinely attractive: Neon branches are cheap and
instant, and it would test the actual managed endpoint. Rejected on the credential — a PR job
that can create and drop database branches holds an API key that can drop the production branch
too, and pull requests are the least trusted code path in the repository. Worth revisiting once
the deploy key work lands and there is a trusted post-merge job to run it in.

## What would change this

Revisit when the exit gate's CI-driven deploy exists: a trusted, post-merge job could rehearse
against a real Neon branch, which is strictly better evidence than a container. Revisit if
Compose ever gains a way to mark a service as excluded from a file rather than merely
unprofiled. And delete the rehearsal service entirely if the rehearsal is ever replaced by a
deploy to a real staging environment, which is what BRD §14 actually asks for.
