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

**Phase 0 — Foundations and guardrails.** Not started. Nothing is built yet; the repo currently holds the BRD and this file.

Do not begin Phase 1 work until Phase 0's exit gate passes: a sample change travels from branch to staging through green CI with no manual secret handling, and rollback plus logs are demonstrated.

## Intended structure

Monorepo, pnpm workspaces. To be scaffolded in Phase 0:

```
apps/web        Next.js frontend (PWA)
apps/api        NestJS backend (Fastify adapter)
apps/worker     BullMQ background jobs
packages/contracts   Shared types and API contracts
packages/config      Versioned configuration schemas
infra/          Terraform
```

Commands will be recorded here once Phase 0 scaffolds them.

## Environment

Windows 11. PowerShell is the primary shell; the Bash tool is available for POSIX scripts. Installed: git, node 24, pnpm 10, docker, gh (authenticated). Not installed: terraform, psql.

Local Postgres/PostGIS and Redis run in Docker. Never point local development at a shared database.

## Conventions

Conventional commits. One vertical slice per feature branch. All changes via PR with green checks. Protected `main`.

Secrets go in the cloud secret manager and `.env.local` — never committed, never in frontend bundles, never in PR jobs.

Migrations use expand-and-contract. Every migration states data impact and a rollback/roll-forward note, and has a test.

Ask before adding a dependency that duplicates something we already have.
