# 0037. Managed Postgres, self-hosted applications

- **Status:** Accepted
- **Date:** 2026-08-09
- **Supersedes:** the hosting half of [0009](0009-self-hosted-vps-with-off-box-backups.md). The
  off-box durability requirement in 0009 stands and is now discharged rather than deferred.
- **Relates to:** BRD §4, §10.2, §12.4, §14; ADR 0004, ADR 0032

## Context

ADR 0009 put everything on one self-managed box and named database durability as the one
obligation it could not comfortably take on: BRD §8.7 requires an immutable ledger, and that is
the single dataset which cannot be reconstructed from the payment provider or from user memory.
Losing it ends the business. The mitigation was "nightly dumps plus WAL archiving to R2, restore
tested before Phase 5" — work that was never started because no box existed.

Two things reopened this on 9 August 2026. The product owner already held Vercel and Railway
accounts, which removed the setup cost that made managed hosting look expensive in July. And
ADR 0009 contained an instruction nobody had executed: _"ADR 0004's `btree_gist` dependency
constrains which providers qualify, and must be checked before choosing."_

**That check was finally run, against real instances rather than documentation, and it was
pointed at the wrong extension.**

- **Railway's managed Postgres (18.4) does not have PostGIS.** `CREATE EXTENSION postgis` fails
  with _"extension is not available"_, and `pg_available_extensions` contains no postgis-named
  row at all — the binaries are absent from the image, so it is not a permissions problem.
  `btree_gist` (1.8), `pg_trgm` and `citext` are all present. **The dependency ADR 0009 flagged
  was fine; the one it never mentioned is what disqualified the provider.**
- **Railway's backups and point-in-time recovery are Pro-plan only.** The Hobby plan has none,
  so the durability obligation would have remained entirely ours at $5/month, or cost $20/user/
  month on a database that still could not run our schema.
- **Neon passed the same tests.** On PostgreSQL 17 in Frankfurt: `postgis` **3.5.0**,
  `btree_gist` 1.7, `pg_trgm` 1.6, `citext` 1.6. An `EXCLUDE USING gist (listing_id WITH =,
period WITH &&)` table was created and an overlapping range was **rejected with SQLSTATE
  23P01**, while the same period against a different listing was accepted. That is BRD §8.5.1's
  mechanism proven on the actual provider, not inferred from a feature list.

PostGIS 3.5.0 was not incidental — the local stack runs `postgis/postgis:17-3.5`, and matching
it means staging does not differ from development on the spatial library that ADR 0032's fuzzed
radius search depends on.

## Decision

Split the stack along the line where managed hosting actually earns its price.

- **Postgres runs on Neon**, PostgreSQL 17, region `aws-eu-central-1` (Frankfurt). This
  discharges ADR 0009's non-negotiable off-box durability requirement without us building WAL
  archiving. The free tier's 6-hour restore window is insufficient once real data exists; the
  Launch plan's 7 days is the floor before anything irreplaceable is stored.
- **Applications run on a Hetzner CX23** (2 vCPU, 4 GB, 40 GB) in Falkenstein — `web`, `api`,
  `worker`, Redis and the H1 observability stack, via the existing `infra/compose`. Postgres
  leaves the compose file and nothing else about it changes.
- **Cloudflare sits in front**, providing DNS, WAF, rate limiting and — the part that is
  normative — a **Tunnel**, so the origin opens no inbound ports and has no address to dial.
- **Redis stays on the box.** BullMQ requires blocking commands and `maxmemory-policy
noeviction`; hosted Redis-compatible services generally provide neither.

4 GB is viable _because_ Postgres left the box. It would not have been otherwise.

## Consequences

**The durability obligation is discharged rather than deferred**, which is the point. ADR 0009's
restore drill becomes "verify Neon's restore works" rather than "build backup tooling".

**Two regions instead of one**, and they must stay matched. Frankfurt and Falkenstein are ~1–5 ms
apart; pairing a German box with Neon's London region would put every query across the Channel.
Neither is a UK region — lawful under UK↔EU adequacy, but if that adequacy lapses this is the
decision that has to be revisited, not a detail.

**A code change is required and was found by running this, not by reading it.**
`buildPostgresUrl` in `packages/config/src/env.ts` emits
`postgresql://user:pass@host:port/db` with no way to express `sslmode`. `psql` connects to Neon
anyway, because libpq defaults to `sslmode=prefer` and negotiates TLS — **but node-postgres,
which is what the applications actually use, refuses outright**: _"connection is insecure (try
using `sslmode=require`)"_. A test run with the wrong client would have reported a false pass.

When that field is added, **its deployed value must be `verify-full`, not `require`.**
node-postgres 8.x treats `require` as an alias for `verify-full`; pg 9 / pg-connection-string 3.0
adopt libpq semantics, under which `require` means encrypted-but-unverified. Written as
`require`, a routine dependency bump silently downgrades database TLS from certificate-verified
to merely encrypted, with nothing failing.

**Migrations and the application need different endpoints.** Prisma's advisory locks do not
survive a transaction pooler, so `migrate deploy` uses Neon's direct endpoint while the
application uses the `-pooler` host. Both are the same credential. `prisma.config.ts` already
honours an explicit `DATABASE_URL`, which is why migrations ran before the `sslmode` gap was
fixed.

**`pg_stat_ssl` is misleading through the pooler.** It reports the pooler-to-Postgres hop, not
the client-to-pooler one, so it reads `ssl = f` on a connection that is in fact TLS. Do not treat
that as evidence of an unencrypted connection.

**A second monthly bill**, and Neon's is usage-based — the cost predictability that ADR 0009
optimised for is now only partly true. At our volume it is small, and the free tier covers the
build phase entirely.

**CX23 is 4 GB and 8 GB was not purchasable.** CX33 showed _"preselected server type is not
available"_ in both Nuremberg and Falkenstein against Hetzner's standing limited-availability
notice. Resizing later is a reboot, not a migration, but the headroom assumption should be
checked before the observability stack and the applications run together.

## Alternatives considered

**Everything self-hosted, per ADR 0009 unchanged.** Cheapest and still coherent. Rejected
because the durability work it defers is the work most likely to be skipped, and skipping it is
the failure mode with no recovery. Paying someone else for point-in-time recovery is worth more
than the £5/month it saves.

**Railway for everything.** Disqualified on evidence: no PostGIS, and backups paywalled at four
times the Hobby price. It would also have meant either running `postgis/postgis` as our own
container — which is self-hosting with extra steps and no backups — or abandoning the schema.

**DigitalOcean managed Postgres.** Genuinely qualified: PostGIS and `btree_gist` on PG 14–18,
London region, backups included, $15.15/month flat with no usage variability. Lost to Neon on
cost during the build phase (Neon is free until there is data) and on scale-to-zero for a
platform that is idle most of the day. **This is the fallback if Neon's usage billing surprises
us**, and the migration is a dump and restore.

**Vercel for `web`, Railway for the rest** — the shape under discussion before the tests were
run. Rejected on BRD §10.2 as much as on the PostGIS finding: both platforms _are_ the origin
and expose their own public endpoints, so an outbound-only tunnel cannot be placed in front, and
the web→api hop would cross the public internet. §10.2 requires that the origin not be reachable
except through the filtering layer, and a managed application platform cannot satisfy it.

**Hostinger rather than Hetzner**, as ADR 0009 originally named. Rejected on the product owner's
own criterion: promotional pricing of $6.99/month renews at $16.99–$24.49, tied to 24 months
paid upfront. ADR 0009 chose self-hosting for cost predictability and named a vendor whose
pricing is the least predictable on the table. Hetzner publishes one price.

**Hetzner's CPX line**, which the console pre-selects. CPX22 is $27.59/month for the same 2 vCPU
and 4 GB that CX23 provides at $7.79 — newer hardware and double the disk, neither of which a
mostly-idle container host needs. Worth recording because the default selection is the expensive
one.

## What would change this

Revisit if Neon's usage billing exceeds roughly $25/month at pilot volume — DigitalOcean's flat
$15.15 then wins on predictability. Revisit if UK↔EU adequacy lapses, which makes UK regions a
requirement rather than a preference and breaks the Frankfurt/Falkenstein pairing. Revisit the
box size if the observability stack and applications together exceed 4 GB, and CX33 by then has
availability. And revisit the split entirely if a second engineer joins, at which point shared
staging and production — inherited unchanged from ADR 0009 — stops being tolerable.
