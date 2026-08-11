# Category-Agnostic P2P Rental Marketplace

UK peer-to-peer rental marketplace. Launch category is DIY tools and garden equipment, but the engine is category-agnostic — categories, fees, attributes, radii, deposits and policies are versioned configuration, never code.

**The specification is `docs/Category_Agnostic_Peer_to_Peer_Rental_Marketplace_BRD_v1.2.md`.** It is normative. v1.1 is superseded and kept only for audit. When this file and the BRD disagree, the BRD wins — and tell me, because one of them needs fixing.

**Read `docs/HANDOFF.md` before doing anything else.** It is the master handoff — current state, what to do next, external account status, product-owner tasks and open questions. `docs/` is **gitignored**, so nothing in version control points at it and a session that reads only the tracked files misses all of that. Per-phase detail lives in `docs/phase-NN-*/HANDOFF.md`, one folder per BRD §14 phase, each holding that phase's scope checklist, exit gate, slices, gaps, tech debt and session log. Cross-cutting engineering lessons are in `docs/LESSONS.md`, and the security posture, gap list and sequencing are in `docs/SECURITY.md`. Keep the master short and put phase detail in the phase folder.

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
- **Edge protection** (§10.2, added 3 August 2026): a filtering layer in front of all public traffic, and — the part that is normative and easy to undo — **the origin must not be reachable except through it**. A WAF that can be bypassed by dialling the origin directly is not a control, and the address is discoverable from historic DNS and certificate transparency. An outbound-only tunnel, or an edge-range allowlist **plus mutual TLS**; an IP allowlist alone is insufficient because it proves traffic came from the provider, not that it was sent for our zone. Automatic bans are time-boxed and self-expiring — a permanent one eventually excludes real users behind shared NAT with no route back — and every automated throttle or ban is audited and reversible.
- **Admin second factor** (ADR 0021, with the exception in ADR 0030): administrative access requires a second factor verified in the last 12 hours, and an absent claim fails closed. Clerk gates MFA behind a paid plan, so **`DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA=true` opens the admin surface in local development only** — the API **refuses to start** with it set under `NODE_ENV=production`, it removes the second factor and never the role or suspension checks, and every admin page carries a banner while it is on. Buying Clerk Pro deletes the flag; do not weaken ADR 0021 instead.
- **Identity** (ADR 0015): Clerk holds credentials; `users` is a **mirror** and `users.id` is the platform identity that every later foreign key points at. `clerkUserId` is an ordinary column, never a primary key. The **API is given only the JWT public key** — never `CLERK_SECRET_KEY` — which keeps session verification networkless and means a compromised API yields a key Clerk already publishes. The web app holds the secrets because Clerk's Next SDK requires it. Deletion is a soft delete with a tombstoned email; the ledger will reference these rows and can never lose a counterparty.

## Current status

**Phase 0 — Foundations and guardrails. Complete except the exit gate.** Every Phase 0 slice that does not need a machine is merged.

**Phase 1 — Identity and basic profiles. Build list complete, exit gate unmet.** Started on the product owner's decision with the Phase 0 gate not yet met: BRD §14 says not to, and §14 also makes progression their call; they made it on 28 July 2026 rather than sit idle waiting for a VPS. Phase 1 has its own staging requirement, so this defers the blocker rather than removing it. **Nothing goes to a real environment, and no real data is created, until the gate is met and backups exist.**

**Phases 2–12 have not been started.** No categories, listings, search, bookings, payments, messaging, handover protocol, reviews, disputes or admin dashboards. What exists is a platform that knows who somebody is, protects what it knows about them, and can be administered safely — it is not yet a marketplace.

**The per-slice table lives in the phase handoffs**, not here — `docs/phase-00-foundations/HANDOFF.md` and `docs/phase-01-identity-and-profiles/HANDOFF.md`. In summary: Phase 0 delivered the monorepo, primitives, local stack, CI, environment validation, logging, ADRs, the invariant checker, all three applications and the deployment foundation. Phase 1 delivered identity on Clerk with a mirrored `users` table, profiles with a public/private split, an append-only audit log, deletion with real erasure, data export, email correction, and the whole administrative surface — role with MFA at the guard, read-only account and activity views, dual approval on role changes, suspension, and sign-in history.

**The admin surface can be operated in local development from 4 August 2026** — see ADR 0030 and the note in the normative list above. Before that, Clerk's paid-plan MFA gate meant no admin page opened for anybody, anywhere, and four slices shipped a surface no human had used.

**One BRD Phase 1 line item was never built:** the `Seller tax profile` entity, required by §14 to be present but inactive per §8.14.2. It was missed because §8.14.1 concluded the platform is not a Reporting Platform Operator for the launch category — true, and it does not remove the requirement for the empty entity. Recommended for Phase 2, beside the category reportable-activity flag it exists for.

Still outstanding against the BRD §14 Phase 0 list:

- ~~**No VPS**~~ — **provisioned 9 August 2026.** Hetzner CX23, Falkenstein, hardened: key-only SSH, root password locked, `ufw` default-deny with port 22 the sole opening, unattended security upgrades, Docker. Verified after a reboot, which is what proves cloud-init does not silently undo it.
- ~~**No durable backups**~~ — **discharged 9 August by ADR 0037.** Neon holds the database and its backups. **The restore drill is still owed**, and the free tier's restore window is only **6 hours** — move to Launch before anything irreplaceable is stored. Until then: **nothing irreplaceable goes in a deployed database.**
- **No domain, so no Cloudflare Tunnel — and the box therefore has a reachable public IP.** BRD §10.2 forbids exactly that. This is now the shortest pole in the project and it blocks the WAF and rate limiting too.
- ~~**`buildPostgresUrl` cannot express `sslmode`**~~ — **fixed 9 August, slice 0.9c, ADR 0038.** `POSTGRES_SSLMODE` takes three values only — `disable`, `no-verify`, `verify-full` — and **refuses `require`**, which is what Neon's own console hands you: pg 9 redefines it as encrypted-but-unverified, so a dependency bump would downgrade database TLS with nothing failing. Required under `NODE_ENV=production`.
- **The deploy is real but hand-driven.** Staging has been deployed to the box against Neon and is serving — `web`, `api`, `worker`, Redis, no Postgres container, no published ports. **A human ran it**, which is precisely the clause the exit gate cares about: it wants the change to travel _from CI_ with no manual secret handling. That needs an SSH deploy key in repository secrets, and it is now the only unmet clause.

**Exit gate (BRD §14):** a sample change travels from branch to staging through green CI with no manual secret handling, and rollback plus logs are demonstrated. **Still unmet.** Phase 1 was nonetheless started on 28 July 2026 by the product owner's decision — see the status note above. That does not relax the gate: it must be met before anything is deployed for real, and Phase 1's own exit gate requires staging too.

**Hosting.** BRD §4 and §14 originally named AWS, Azure or GCP provisioned with Terraform. Both were amended on 27 July 2026 to require reproducible infrastructure as code without naming a tool, deferring to ADR 0009. **ADR 0037 (9 August 2026) supersedes the hosting half of ADR 0009 and is what runs today:** applications on a **Hetzner CX23 in Falkenstein** via `infra/compose`, and **Postgres managed on Neon** (PostgreSQL 17, Frankfurt), which discharges ADR 0009's off-box durability requirement rather than deferring it. Cloudflare sits in front for DNS, WAF and — the part §10.2 makes normative — a Tunnel, so the origin opens no inbound ports. Redis stays on the box because BullMQ needs blocking commands and `noeviction`, which hosted Redis-compatible services generally do not provide. Appendix A.1 still lists Terraform as a validated 2026 choice; that is a research record and does not bind the build.

**Two things about the database that are easy to get wrong.** Postgres is **17, not 18**, deliberately: Neon's PG17 carries PostGIS **3.5.0**, matching the local `postgis/postgis:17-3.5` so staging cannot differ from development on the library ADR 0032's radius search depends on. And **migrations use Neon's direct endpoint while the application uses the `-pooler` one** — Prisma's advisory locks do not survive a transaction pooler. A provider qualifies for this project only if it has `postgis`, `btree_gist`, `pg_trgm` and `citext`; **Railway was rejected because it has no PostGIS at all**, which ADR 0009's note about `btree_gist` would never have caught.

**Security.** BRD §10 was amended on 3 August 2026, on the product owner's instruction, after it turned out to require rate limiting and an incident plan but nothing in front of the platform, nothing about how limits behave once traffic turns hostile, and nothing about availability attacks as their own incident class. Three bullets were added plus a new **§10.2, _Edge protection and denial-of-service readiness_**, which is the binding text and is summarised in the normative list above. The working detail — current posture, gap list, options weighed, costs and sequencing — is in **`docs/SECURITY.md`**. Its central finding is that most of the security work lands in **slice 0.9b, when the VPS is provisioned** — which happened on 9 August 2026, so **that checklist is now due rather than hypothetical**, and the host-hardening items on it are already done — not at Phase 11; and that three gaps are live against §10 today with no infrastructure needed — **there is no rate limiting anywhere**, the browser-facing app sets no CSP or HSTS while the API that no browser reaches does, and nothing alerts a human to anything.

**The BRD is not in version control.** `docs/` is gitignored on purpose — this repository is public and the BRD carries unit economics and strategy. It therefore has no history, no review trail and no off-machine backup. Amendments to it, including the two above, exist only on the product owner's machine. The same is true of everything beside it:

```
docs/                              gitignored in full — .gitignore:4
  HANDOFF.md                       master handoff. Read first, keep short
  LESSONS.md                       cross-cutting engineering lessons
  SECURITY.md                      security handoff — posture, gaps, sequencing
  Category_Agnostic…BRD_v1.2.md    the normative specification
  reference-category-taxonomy.md   category research for Phase 2
  phase-00-foundations/            one folder per BRD §14 phase, 00 through 12
  phase-01-identity-and-profiles/    each: scope checklist, exit gate, slices,
  …                                  gaps, tech debt, session log
```

**When you finish a slice, update the phase folder with the detail and the master with only the status line, branch state and session-index row.** That split is what stops the master growing back into something nobody reads — it was 1239 lines before session 20 split it.

## Branch protection

`main` requires a pull request, linear history and resolved conversations. Force pushes and deletions are blocked. **Nine checks** must pass before merge: `Format, lint and types`, `Unit tests and coverage`, `Build`, `Database invariants`, `Container image`, `Deploy rehearsal`, `Worker integration`, `Secrets and dependencies` and `Analyse` (CodeQL). Branches must be up to date with `main` before merging.

Adding a CI job does not make it blocking — the required-check list is repository configuration and has to be updated separately, or the new job runs advisory-only.

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
packages/database       Prisma schema, migrations, client factory
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

**This is not the Next.js most documentation and most training data describe.** `apps/web` is on **Next 16**, whose APIs, conventions and file layout differ from 15 and earlier in ways that do not announce themselves — code that looks idiomatic can be a version behind. Next ships its own docs inside the package: read the relevant guide under **`node_modules/next/dist/docs/`** before writing app code, resolving it from `apps/web` rather than the repository root, because pnpm may not surface `next` at the top level. Heed its deprecation notices.

That warning is here, in our own words, because **Next 16.3 wanted to write it into the repository itself** — it generates `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` on every `next dev`, and Claude Code loads the latter as project instructions. It is switched off with `agentRules: false` in `apps/web/next.config.mjs`, which explains why: a dependency that authors agent instructions can revise them on any version bump, the change arrives on disk the next time somebody runs the dev server rather than in a reviewable diff, and it is obeyed before anyone notices. **Do not turn it back on to "keep the tree clean"** — that trades a reviewable instruction for an unreviewable one.

**The app stack runs for real** on the Hetzner CX23 against Neon (ADR 0037), deployed by `scripts/deploy.mjs` on 9 August 2026. **Two things in `infra/compose` still have not run**: the Caddy ingress and the observability stack. The ingress is deliberately down — it listens for inbound traffic, Cloudflare's Tunnel makes that the wrong shape, and until a domain exists bringing it up would put plain HTTP on a dialable public IP. Reach the stack over an SSH tunnel meanwhile. See `infra/compose/README.md`, which was corrected by the first real run.

**Request path.** Browser → Caddy ingress → `web` → (server-side) `api` → Postgres/Redis. Only `web` joins the `edge` network; the API is not reachable from the internet, and CI asserts that. When a browser-facing API route is genuinely needed, add it deliberately.

`apps/web/src/app/api/webhooks/clerk` is the **one such route that exists**, added deliberately in slice 1.2: Clerk cannot reach the API directly, so the web app verifies the delivery's signature — it is where the raw unparsed body exists — and forwards the event inward. The API owns what the event means and is the only service that writes.

**Clerk instance configuration is load-bearing and lives outside version control.** Staging and production must use **separate Clerk instances** — a shared one means a staging sign-up creates a production account. The provisioning list is in ADR 0015, and **every item on it fails silently if missed**, which is why it is repeated here:

- a custom **`email` session claim** — without it the API rejects every authenticated request;
- the **`fva` factor-verification claim** (ADR 0021) — without it, correctly-signed tokens carry no proof of a second factor and every admin page refuses everyone;
- a **webhook endpoint** and its signing secret, subscribed to `user.created`, `user.updated`, `user.deleted` **and the four `session.*` events** (ADR 0025) — without the session events the sign-in history stays empty and nothing errors;
- **`delete_self_enabled` off** (ADR 0018) — otherwise Clerk's own delete button bypasses the page BRD §10.1 requires, which explains what survives;
- **new-device alert emails left on** (ADR 0026) — they are the only suspicious-login alerting that exists until an email channel does.

The API is given only the JWT public key, never `CLERK_SECRET_KEY`.

## Commands

| Command                      | Does                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `pnpm test`                  | Unit suite (`test:watch`, `test:coverage` for the variants)   |
| `pnpm test:integration`      | Redis-backed tests; needs `pnpm db:up`                        |
| `pnpm typecheck`             | Typecheck every package, tests included                       |
| `pnpm lint`                  | ESLint                                                        |
| `pnpm format:check`          | Prettier, verify only (`pnpm format` writes)                  |
| `pnpm build`                 | Build all packages                                            |
| `pnpm invariants`            | Project invariant checks — the rules in this file             |
| `pnpm verify:runtime`        | Confirm built packages load in a real Node process            |
| `pnpm --filter @app/api dev` | Run the API locally on **3001** against `.env`                |
| `pnpm --filter @app/web dev` | Run the web app locally on 3000 (needs `apps/web/.env.local`) |
| `pnpm db:up` / `db:down`     | Start / stop the local Postgres and Redis stack               |
| `pnpm db:migrate`            | Create and apply a migration against local dev                |
| `pnpm db:migrate:deploy`     | Apply pending migrations (what the deploy runs)               |
| `pnpm db:migrate:status`     | What is applied and what is pending                           |
| `pnpm db:generate`           | Regenerate the Prisma client                                  |
| `pnpm db:verify`             | Assert extensions, exclusion constraint and Redis eviction    |
| `pnpm db:reset`              | Destroy volumes and rebuild from scratch                      |
| `pnpm licences:check`        | Dependency licence check                                      |
| `pnpm hooks:install`         | Reinstall git hooks (runs automatically after install)        |

Deployment commands run on the box, not here, and take no pnpm wrapper — they must work when only Node and Docker are present:

| Command                                             | Does                                         |
| --------------------------------------------------- | -------------------------------------------- |
| `node scripts/deploy.mjs --env <env> --tag <sha>`   | Deploy, health-check, auto-revert on failure |
| `node scripts/deploy.mjs --env <env> --rollback`    | Return to the previous release               |
| `node scripts/deploy.mjs --env <env> --status`      | What is recorded, what is running            |
| `node scripts/logs.mjs --env <env> [--service api]` | Retrieve logs; `--env ingress` for the edge  |

**Prisma is on 7, which is not what most documentation assumes.** `url` is banned from `schema.prisma` and lives in `prisma.config.ts`; the client needs a driver adapter; the generator emits TypeScript source, which is gitignored and regenerated on install. Migrations ship as their own image and run before the stack comes up. ADR 0014 records what the compatibility gate found and what was rejected.

Integration tests (`*.db.test.ts`, `*.redis.test.ts`) need `pnpm db:up` **and** `pnpm db:migrate:deploy` against the test database.

Coverage thresholds are enforced in `vitest.config.ts`: 90% lines, functions and statements, 85% branches, and cover `packages/*/src` and `apps/*/src` only. `scripts/` is outside them deliberately — its pure logic is unit tested under the `scripts` vitest project, and the parts that drive Docker are covered by the `Deploy rehearsal` CI job instead. `.nvmrc` pins Node 22; CI runs Node 24.

## Environment

Windows 11. PowerShell is the primary shell; the Bash tool is available for POSIX scripts. Installed: git, node 24, pnpm 10, docker, gh (authenticated). Not installed: terraform, psql.

Local Postgres/PostGIS and Redis run in Docker. Never point local development at a shared database.

## Conventions

Conventional commits. One vertical slice per feature branch. All changes via PR with green checks. Protected `main`.

Secrets go in the cloud secret manager and `.env.local` — never committed, never in frontend bundles, never in PR jobs.

Two env files, not one: the repository-root `.env` is the API's and the worker's; `apps/web/.env.local` is the web app's. The split is deliberate — the web app is the only process a browser can reach, so it holds no database credentials at all. Each has an `.env.example` beside it. Note that `.gitignore` ignores `.env.*` and negates only `!.env.example`, so an example file named anything else is silently untracked.

Migrations use expand-and-contract. Every migration states data impact and a rollback/roll-forward note, and has a test.

Ask before adding a dependency that duplicates something we already have.
