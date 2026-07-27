# Rental Marketplace

Category-agnostic peer-to-peer rental marketplace for the UK. Launch category is DIY tools and garden equipment, but categories, fees, attributes, radii, deposits and policies are versioned configuration rather than code.

Currently in **Phase 0 — foundations**. There is no application yet, only the workspace, primitives and local stack.

## Prerequisites

| Tool   | Version         | Notes                                                                                               |
| ------ | --------------- | --------------------------------------------------------------------------------------------------- |
| Node   | 22.12 or later  | `.nvmrc` pins 22. Not merely 22 — see [ADR 0011](./adr/0011-api-is-commonjs-in-an-esm-workspace.md) |
| pnpm   | 10              | `corepack enable` if not installed                                                                  |
| Docker | with Compose v2 | Runs Postgres/PostGIS and Redis locally                                                             |

## Setup

```bash
pnpm install
cp .env.example .env
pnpm db:up          # start Postgres + Redis, wait for healthy
pnpm db:verify      # confirm extensions and constraints
pnpm test
```

`pnpm db:verify` is worth running whenever the stack misbehaves. It checks more than liveness — that PostGIS, `btree_gist`, `pg_trgm` and `citext` exist in **both** databases, that Redis is on `noeviction`, and that a booking-overlap exclusion constraint genuinely rejects overlapping periods.

## Commands

| Command                  | Does                                               |
| ------------------------ | -------------------------------------------------- |
| `pnpm test`              | Run the unit suite                                 |
| `pnpm test:watch`        | Watch mode                                         |
| `pnpm test:coverage`     | With coverage thresholds (90% lines, 85% branches) |
| `pnpm typecheck`         | Typecheck every package, tests included            |
| `pnpm lint`              | ESLint                                             |
| `pnpm format`            | Prettier, write                                    |
| `pnpm db:up` / `db:down` | Start / stop the local stack                       |
| `pnpm db:reset`          | Destroy volumes and rebuild from scratch           |
| `pnpm db:verify`         | Verify stack configuration                         |
| `pnpm db:psql`           | Interactive psql session                           |
| `pnpm db:logs`           | Follow container logs                              |
| `pnpm invariants`        | Check project-specific invariants                  |
| `pnpm verify:runtime`    | Confirm built packages load in a real Node process |
| `pnpm hooks:install`     | Reinstall git hooks (automatic after install)      |

## Running the API

```bash
pnpm build
pnpm --filter @app/api dev     # loads ../../.env, restarts on change
```

Then `curl localhost:3000/health` and `curl localhost:3000/ready`.

**`/health` is liveness and depends on nothing.** **`/ready` is readiness and genuinely checks Postgres and Redis**, each with its own timeout, returning 503 with a per-dependency status when one is down.

The split matters. If liveness consulted the database, a database outage would tell the orchestrator the process is dead, and it would restart a perfectly healthy container — turning a recoverable dependency failure into a restart loop. Stop Redis and watch `/ready` return 503 while `/health` stays 200, then start it again and watch readiness recover without a restart.

A failed check reports only `failed` or `timeout`. The underlying driver error goes to the log instead, because it names hosts, ports and users, and sometimes the connection string.

Every response carries an `x-correlation-id`. An inbound one is honoured so a trace survives the hop from the web app, but only after sanitising — the header is attacker-controlled and reaches the logs, where an unchecked newline would let a caller forge log entries.

To build and run the container the way staging will:

```bash
docker build -f apps/api/Dockerfile -t rental-api .
```

It runs as a non-root user, handles SIGTERM so a deploy drains rather than being killed, and its `HEALTHCHECK` deliberately calls liveness only.

## Guardrails

`pnpm invariants` enforces rules no off-the-shelf linter knows about, each tied to a decision in `adr/` — money never touched by `toFixed` or `parseFloat`, environment read only through `@platform/config`, logging only through `@platform/observability` so redaction applies, raw SQL confined to the search module.

Every rule supports an inline waiver, with a required reason:

```ts
// invariant-ok: no-console — CLI output, not application logging
```

A bare waiver is itself a failure: an unexplained exemption is indistinguishable from someone silencing the check.

Git hooks install automatically on `pnpm install`. **pre-commit** runs the invariant check and formatting on staged files. **pre-push** scans for secrets with gitleaks when Docker is available — the last point at which a leak is still preventable, since a pushed secret is scraped within seconds and rewriting history does not un-leak it.

Both are deliberately fast. A slow hook is a bypassed hook, so anything needing the database or the full test suite belongs in CI.

## Layout

```
apps/api                 NestJS API (Fastify)
packages/core            Money and time primitives
packages/config          Brand identity and configuration
packages/observability   Logging, correlation IDs, error tracking
infra/postgres           Database initialisation
scripts/                 Developer tooling
```

`apps/web`, `apps/worker` and `packages/contracts` arrive in later slices.

## Two databases

`rental_dev` for development, `rental_test` for the integration suite. Tests may truncate freely without destroying development data. Never point local development at a shared database.

## Conventions

Money is an integer count of pence plus a currency code — never a float. Timestamps are stored in UTC; rental duration is counted in local calendar days, not elapsed time, because UK clock changes make some days 23 or 25 hours long. Use the helpers in `@platform/core` rather than the `Date` global, which ESLint blocks outside the time module.

The full engineering rules are in `CLAUDE.md`.

## Troubleshooting

**`port is already allocated` on startup.** Another Postgres is using the port. The stack defaults to **5433** for this reason, but if that is also taken, change `POSTGRES_PORT` in `.env` and update `DATABASE_URL` to match.

**Extensions missing after `db:up`.** The init script only runs when the data volume is empty. Run `pnpm db:reset` to rebuild from scratch.

## Continuous integration

Every pull request runs: formatting, lint, typecheck (tests included), unit tests with coverage thresholds, build, a **runtime import check**, dependency audit, licence check, an incremental secret scan, CodeQL, and a **database invariants** job that asserts PostGIS and `btree_gist` are present and that a booking-overlap exclusion constraint genuinely rejects overlapping periods.

There is also a **container image** job. It builds the real image, boots it, asserts liveness, then sends SIGTERM and requires a clean exit within ten seconds — because an unhandled SIGTERM shows up as random 502s during every release rather than as an obvious bug.

The runtime import check exists because the unit suite resolves `@platform/*` to TypeScript source and therefore never loads the built output. That gap let every package ship an entry point no running process could load, while 143 tests stayed green — see [ADR 0010](./adr/0010-packages-expose-source-types-and-built-runtime.md). A test runner that resolves source is not testing the artefact you deploy.

Secret scanning is deliberately split. The pull request scan is incremental — it covers the commits being introduced, which is fast and catches leaks at the point they appear. A separate workflow scans **every commit** weekly and on each push to `main`, because an incremental scan can never establish a baseline or find a secret that predates the scanner. On a public repository that distinction matters: a pushed secret is scraped within seconds, and rewriting history does not un-leak it.

Any `pnpm audit` exception is documented with a justification and a review trigger in [`AUDIT-EXCEPTIONS.md`](./AUDIT-EXCEPTIONS.md). An undocumented ignore is not acceptable.

## Observability

`@platform/observability` provides structured logging, correlation IDs and an error-tracking seam.

Logs are one JSON object per line — a pretty log is an unsearchable log. Every record carries the correlation id from the ambient context automatically, so a failure can be traced across API, workers and provider adapters without threading an id through every signature.

**Everything logged is redacted first.** Credentials and payment data, obviously, but also precise coordinates: the public API deliberately withholds a listing's true location so an owner's address cannot be trilaterated, and logging it would undo that. Redaction is applied to fields, nested objects, error messages and stack traces.

Error tracking sits behind an interface with a no-op production adapter and a recording test fake. The Sentry adapter is deliberately absent until there is an account and DSN to exercise it — an untested adapter is worse than none, because it looks finished.

## Configuration

Environment variables are validated at startup by `@platform/config`. Validation reports **every** problem at once rather than one per restart, and names the fix.

`.env.example` deliberately contains **no connection strings**. `DATABASE_URL` and `REDIS_URL` are composed at runtime from the individual `POSTGRES_*` and `REDIS_*` parts, which means each credential appears exactly once, no credential-shaped string is ever committed, and the password is percent-encoded correctly — a password containing `@`, `:` or `/` silently produces a malformed URL when a connection string is hand-written.

Always pass connection strings through `redactUrl()` before logging. A failed connection typically reports the URL it tried, which is how passwords reach log aggregators.

## Secrets

Never commit secrets — this repository is public. `.env` holds local Docker values only, and they are deliberately worthless placeholders. Real credentials belong in `.env.local` and in the host secret manager.
