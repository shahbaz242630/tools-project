# Rental Marketplace

Category-agnostic peer-to-peer rental marketplace for the UK. Launch category is DIY tools and garden equipment, but categories, fees, attributes, radii, deposits and policies are versioned configuration rather than code.

Currently in **Phase 0 — foundations**. There is no application yet, only the workspace, primitives and local stack.

## Prerequisites

| Tool   | Version         | Notes                                   |
| ------ | --------------- | --------------------------------------- |
| Node   | 22 or later     | `.nvmrc` pins 22                        |
| pnpm   | 10              | `corepack enable` if not installed      |
| Docker | with Compose v2 | Runs Postgres/PostGIS and Redis locally |

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

## Layout

```
packages/core      Money and time primitives
packages/config    Brand identity and configuration
infra/postgres     Database initialisation
scripts/           Developer tooling
```

`apps/web`, `apps/api`, `apps/worker` and `packages/contracts` arrive in later slices.

## Two databases

`rental_dev` for development, `rental_test` for the integration suite. Tests may truncate freely without destroying development data. Never point local development at a shared database.

## Conventions

Money is an integer count of pence plus a currency code — never a float. Timestamps are stored in UTC; rental duration is counted in local calendar days, not elapsed time, because UK clock changes make some days 23 or 25 hours long. Use the helpers in `@platform/core` rather than the `Date` global, which ESLint blocks outside the time module.

The full engineering rules are in `CLAUDE.md`.

## Troubleshooting

**`port is already allocated` on startup.** Another Postgres is using the port. The stack defaults to **5433** for this reason, but if that is also taken, change `POSTGRES_PORT` in `.env` and update `DATABASE_URL` to match.

**Extensions missing after `db:up`.** The init script only runs when the data volume is empty. Run `pnpm db:reset` to rebuild from scratch.

## Continuous integration

Every pull request runs: formatting, lint, typecheck (tests included), unit tests with coverage thresholds, build, dependency audit, licence check, an incremental secret scan, CodeQL, and a **database invariants** job that asserts PostGIS and `btree_gist` are present and that a booking-overlap exclusion constraint genuinely rejects overlapping periods.

Secret scanning is deliberately split. The pull request scan is incremental — it covers the commits being introduced, which is fast and catches leaks at the point they appear. A separate workflow scans **every commit** weekly and on each push to `main`, because an incremental scan can never establish a baseline or find a secret that predates the scanner. On a public repository that distinction matters: a pushed secret is scraped within seconds, and rewriting history does not un-leak it.

Any `pnpm audit` exception is documented with a justification and a review trigger in [`AUDIT-EXCEPTIONS.md`](./AUDIT-EXCEPTIONS.md). An undocumented ignore is not acceptable.

## Configuration

Environment variables are validated at startup by `@platform/config`. Validation reports **every** problem at once rather than one per restart, and names the fix.

`.env.example` deliberately contains **no connection strings**. `DATABASE_URL` and `REDIS_URL` are composed at runtime from the individual `POSTGRES_*` and `REDIS_*` parts, which means each credential appears exactly once, no credential-shaped string is ever committed, and the password is percent-encoded correctly — a password containing `@`, `:` or `/` silently produces a malformed URL when a connection string is hand-written.

Always pass connection strings through `redactUrl()` before logging. A failed connection typically reports the URL it tried, which is how passwords reach log aggregators.

## Secrets

Never commit secrets — this repository is public. `.env` holds local Docker values only, and they are deliberately worthless placeholders. Real credentials belong in `.env.local` and in the host secret manager.
