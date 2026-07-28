# Category-Agnostic P2P Rental Marketplace

UK peer-to-peer rental marketplace. Launch category is DIY tools and garden equipment, but the engine is category-agnostic — categories, fees, attributes, radii, deposits and policies are versioned configuration, never code.

**The specification is `docs/Category_Agnostic_Peer_to_Peer_Rental_Marketplace_BRD_v1.2.md`.** It is normative. v1.1 is superseded and kept only for audit. When this file and the BRD disagree, the BRD wins — and tell me, because one of them needs fixing.

**Before changing anything that looks odd, check `adr/`.** Several decisions here look like overengineering until you know the constraint behind them — why money splits use `allocate` rather than `multiply`, why a rental "day" is not 24 hours, why the brand name lives in one file. The ADRs record what was rejected and why. If you still disagree after reading, supersede the ADR rather than quietly changing the code.

Team is two people: one product owner (non-coder) and Claude as the engineer. There is no other dev team, no QA team and no budget. Optimise for correctness and low operating cost, not for scale we don't have.

## Operating discipline

Work one vertical slice at a time, within the approved phase only. Before writing code, restate: the slice, affected modules, data changes, API contract, tests, and security considerations. After the slice is green, produce the completion report (BRD §15.1) and **stop for approval**. Do not roll into the next slice.

A slice is not done until UI, API, database, permissions, error handling, monitoring and tests are all connected. No dead controls — every tab, button and link either calls real API behaviour or is visibly feature-flagged.

Write tests alongside implementation. Reproduce every bug with a failing test before fixing it. Never bypass tests, linting, migrations, permissions or CI to make something look finished.

## Invariants — never violate these

**Money.** Integer minor units (pence) plus an ISO 4217 currency code on the same record. Floats for money are banned in the database, API contracts and business logic. Rounding lives in the pricing service only.

**Time.** Store UTC. Render and calculate rental periods in the booking's stored IANA timezone (`Europe/London` at launch). Daily rates, due times and late fees must be correct across BST transitions.

**Configuration.** Never hard-code category names, fee percentages, radii, deposit bands, status labels, minimum values or provider credentials. If it might change without a deploy, it is configuration.

**Module boundaries.** No direct cross-module database writes. Modules talk through application services, interfaces or domain events. Modules are listed in BRD §5.1.

**Providers.** Every external provider gets an interface, a production adapter, a test fake, and an explicit timeout/error strategy. Never import a provider SDK outside its adapter.

**Idempotency.** Every payment operation, webhook handler, notification send and state transition is idempotent. Webhook events and idempotency keys are persisted entities, not in-memory tricks.

**Ledger.** Immutable. Corrections are reversing entries. Never edit or delete a ledger row.

**Business logic placement.** Not in UI components, route handlers or ORM models. Domain and application services only.

## Normative mechanisms — implement as specified or raise an ADR first

These were chosen deliberately after research. Deviating silently is a defect.

- **Double-booking prevention** (§8.5.1): PostgreSQL `EXCLUDE` constraint with `btree_gist` over `listing_id WITH =` and a `tstzrange WITH &&`, scoped to calendar-occupying states. `REQUESTED` is deliberately non-blocking.
- **Damage security timing** (§8.7.2): authorise at the collection window, never at reservation. The held amount is a hard ceiling — overcapture is unavailable to us. Aggregate everything into one capture. Read the provider's real expiry timestamp (`capture_before`); never assume a duration. Visa merchant-initiated re-auths hold 5 days, not 7. A failed hold means `SECURITY_FAILED`, never a silent unsecured handover.
- **Location privacy** (§8.4.1): one deterministic fuzz offset per listing, persisted at creation, minimum 500 m. Never recompute per request — that leaks the true point through averaging. Public APIs never return true coordinates pre-booking. Distances are bucketed.
- **Total price display** (§3.4.4): search results, listing cards, listing pages and quotes all show totals inclusive of mandatory fees. Drip pricing is a legal exposure, not a UX preference. Refundable damage security is shown separately and never folded into the headline.
- **Prisma + PostGIS** (§4.2): Prisma has no geography support. Keep `latitude`/`longitude` as ordinary columns so the model stays writable; maintain a **nullable** `Unsupported("geography(Point,4326)")` column by trigger; GiST index it; raw SQL for radius queries, confined to the Search & Location module behind a repository interface.
- **Notification channels** (§4.1): iOS web push only works for home-screen-installed apps. Push is supplementary. Every critical event must be deliverable by email or SMS, and a critical send with no non-push channel is a failure, not a silent success.
- **No platform-funded cover** (§8.15.1): never build an advertised cover amount, cover tier or damage guarantee funded by us. Substance beats labels — that is regulated insurance. Cover above the hold comes only from an authorised partner, from Phase 10.

## Current status

**Phase 0 — Foundations and guardrails. In progress.** Slices 0.1 to 0.8 are merged. The exit gate is **not** met, so Phase 1 is not unlocked.

| Slice | What landed                                                       | PR  |
| ----- | ----------------------------------------------------------------- | --- |
| 0.1   | Money and time primitives, pnpm workspace scaffold                | #1  |
| 0.2   | Local Postgres/PostGIS and Redis stack with a verification script | #2  |
| 0.3   | CI pipeline, CodeQL, CODEOWNERS, PR template, branch protection   | #3  |
| 0.4   | Environment validation, connection strings composed from parts    | #12 |
| 0.5   | Structured logging, correlation IDs, error-tracking seam          | #16 |
| 0.6   | Architecture decision records 0001 to 0009                        | #17 |
| 0.7   | Invariant checker, git hooks, project skills                      | #18 |
| 0.8a  | Made workspace packages loadable by a real Node process           | #22 |
| 0.8   | `apps/api` — NestJS on Fastify, health and readiness, container   | #23 |
| 0.11a | `apps/worker` — BullMQ, correlation across the queue, container   | #24 |
| 0.9a  | GHCR image publishing, deployment stack, deploy/rollback/logs     | #25 |
| 0.11b | `apps/web` on Next.js, `packages/contracts`, both deployed        | #26 |

Still outstanding against the BRD §14 Phase 0 list:

- **No VPS, so no staging environment.** The infrastructure is now defined as code in `infra/compose` and rehearsed in CI on every pull request, but it has never run on a real box. Slice 0.9b. This is the only remaining blocker.
- **No off-box backups.** ADR 0009 calls them non-negotiable. Until they exist, nothing irreplaceable goes in a deployed database.
- **Rollback and log retrieval are demonstrated mechanically, not against staging.** The `Deploy rehearsal` CI job proves the mechanism on every PR. The exit gate asks for it against a real environment.

**Exit gate (BRD §14):** a sample change travels from branch to staging through green CI with no manual secret handling, and rollback plus logs are demonstrated. Do not begin Phase 1 work until that is true.

**Hosting.** BRD §4 and §14 originally named AWS, Azure or GCP provisioned with Terraform. Both were amended on 27 July 2026 to require reproducible infrastructure as code without naming a tool, deferring to ADR 0009: a self-hosted Hostinger KVM VPS running Docker Compose, staging and production sharing one box at first, database backups held off the box. Appendix A.1 still lists Terraform as a validated 2026 choice; that is a research record and does not bind the build.

**The BRD is not in version control.** `docs/` is gitignored on purpose — this repository is public and the BRD carries unit economics and strategy. It therefore has no history, no review trail and no off-machine backup. Amendments to it, including the one above, exist only on the product owner's machine.

## Branch protection

`main` requires a pull request, linear history and resolved conversations. Force pushes and deletions are blocked. Seven checks must pass before merge: `Format, lint and types`, `Unit tests and coverage`, `Build`, `Database invariants`, `Container image`, `Secrets and dependencies` and `Analyse` (CodeQL). Branches must be up to date with `main` before merging.

Adding a CI job does not make it blocking — the required-check list is repository configuration and has to be updated separately, or the new job runs advisory-only.

**Currently advisory, should be required:** `Worker integration` (added in 0.11a) and `Deploy rehearsal` (added in 0.9a). Both are green and neither blocks a merge until the protection list is updated to nine checks.

**Known gap, accepted:** `enforce_admins` is off. With a single maintainer that is a deliberate escape hatch, but it means every rule above can be bypassed by the person who merges everything. It makes bypass a deliberate act rather than the default, which is the most a solo repository can enforce against itself.

## Structure

Monorepo, pnpm workspaces (`packages/*`, `apps/*`).

Exists today:

```
apps/web                Next.js 16 App Router. The only service the ingress reaches
apps/api                NestJS on Fastify. Health, readiness, correlation, Dockerfile
apps/worker             BullMQ. Maintenance queue, correlation across the boundary
packages/core           Money and time primitives
packages/config         Brand identity, environment validation (server and web)
packages/contracts      Shared API types with runtime validation
packages/observability  Logging, correlation IDs, error-tracking seam
packages/runtime        Process lifecycle — graceful shutdown, shared by both apps
infra/postgres          Database initialisation SQL
infra/compose           Deployment stack, shared ingress, provisioning runbook
scripts/                Stack verification, licences, invariants, hooks, deploy, logs
adr/                    Architecture decision records
```

`docker-compose.yml` at the root is the **local development** stack. `infra/compose/` is what gets deployed — it runs published images by immutable tag, never builds, and publishes no ports except the ingress. Do not conflate them.

**Both apps diverge from the workspace tsconfig, in opposite directions, and neither is drift.**

- `apps/api` is **CommonJS while everything else is ESM**. NestJS depends on legacy decorator metadata, and `module: NodeNext` is the only setting under which a CommonJS app can import our ESM packages at all. ADR 0011.
- `apps/web` uses **`moduleResolution: bundler`**, so its relative imports carry **no `.js` extension** — the opposite of everywhere else. Next ships no `exports` map, so `next/link` is unresolvable under NodeNext. ADR 0013.

Adding `.js` to a relative import in `apps/web` breaks the build; removing it anywhere else breaks the runtime. Read both ADRs before "tidying" either.

Defined but never run for real: everything in `infra/compose`. It is rehearsed in CI against the same files, but no VPS exists yet — see `infra/compose/README.md`.

**Request path.** Browser → Caddy ingress → `web` → (server-side) `api` → Postgres/Redis. Only `web` joins the `edge` network; the API is not reachable from the internet, and CI asserts that. When a browser-facing API route is genuinely needed, add it deliberately.

## Commands

| Command                      | Does                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `pnpm test`                  | Unit suite (`test:watch`, `test:coverage` for the variants) |
| `pnpm test:integration`      | Redis-backed tests; needs `pnpm db:up`                      |
| `pnpm typecheck`             | Typecheck every package, tests included                     |
| `pnpm lint`                  | ESLint                                                      |
| `pnpm format:check`          | Prettier, verify only (`pnpm format` writes)                |
| `pnpm build`                 | Build all packages                                          |
| `pnpm invariants`            | Project invariant checks — the rules in this file           |
| `pnpm verify:runtime`        | Confirm built packages load in a real Node process          |
| `pnpm --filter @app/api dev` | Run the API locally against `.env`                          |
| `pnpm --filter @app/web dev` | Run the web app locally (needs `API_BASE_URL`)              |
| `pnpm db:up` / `db:down`     | Start / stop the local Postgres and Redis stack             |
| `pnpm db:verify`             | Assert extensions, exclusion constraint and Redis eviction  |
| `pnpm db:reset`              | Destroy volumes and rebuild from scratch                    |
| `pnpm licences:check`        | Dependency licence check                                    |
| `pnpm hooks:install`         | Reinstall git hooks (runs automatically after install)      |

Deployment commands run on the box, not here, and take no pnpm wrapper — they must work when only Node and Docker are present:

| Command                                             | Does                                         |
| --------------------------------------------------- | -------------------------------------------- |
| `node scripts/deploy.mjs --env <env> --tag <sha>`   | Deploy, health-check, auto-revert on failure |
| `node scripts/deploy.mjs --env <env> --rollback`    | Return to the previous release               |
| `node scripts/deploy.mjs --env <env> --status`      | What is recorded, what is running            |
| `node scripts/logs.mjs --env <env> [--service api]` | Retrieve logs; `--env ingress` for the edge  |

Coverage thresholds are enforced in `vitest.config.ts`: 90% lines, functions and statements, 85% branches, and cover `packages/*/src` and `apps/*/src` only. `scripts/` is outside them deliberately — its pure logic is unit tested under the `scripts` vitest project, and the parts that drive Docker are covered by the `Deploy rehearsal` CI job instead. `.nvmrc` pins Node 22; CI runs Node 24.

## Environment

Windows 11. PowerShell is the primary shell; the Bash tool is available for POSIX scripts. Installed: git, node 24, pnpm 10, docker, gh (authenticated). Not installed: terraform, psql.

Local Postgres/PostGIS and Redis run in Docker. Never point local development at a shared database.

## Conventions

Conventional commits. One vertical slice per feature branch. All changes via PR with green checks. Protected `main`.

Secrets go in the cloud secret manager and `.env.local` — never committed, never in frontend bundles, never in PR jobs.

Migrations use expand-and-contract. Every migration states data impact and a rollback/roll-forward note, and has a test.

Ask before adding a dependency that duplicates something we already have.
