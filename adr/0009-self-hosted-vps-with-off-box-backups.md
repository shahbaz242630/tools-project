# 0009. Self-host on a VPS, with database backups off the box

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §4, §9, §12.4, §14, §3.4 — §4 and §14 amended 27 July 2026 to match this decision

## Context

BRD §4 nominates AWS, Azure or GCP with Terraform. For a two-person team with no budget that is weeks of VPC, IAM and managed-service configuration before a single feature exists, on a free tier that expires after twelve months.

The product owner proposed Hostinger. Verified: their KVM VPS plans provide root access and Docker, and will run Next.js, NestJS, a worker, Postgres/PostGIS and Redis on one box. Their shared hosting will not — it is PHP-oriented — so the choice is specifically KVM VPS.

The real trade is not geography or price. It is **managed versus self-managed**: we take on backups, extension upgrades, TLS renewal, OS patching, zero-downtime deploys and monitoring.

Most of that is acceptable. One part is not. BRD §8.7 requires an immutable ledger reconciled daily against the payment provider. It is the one dataset that cannot be reconstructed from anywhere else — not from the provider, not from user memory. Losing it is not an outage, it is the end of the business.

## Decision

Host on a Hostinger KVM VPS (KVM 2 or better) running Docker Compose.

**Database backups must live off the box.** Nightly dumps plus WAL archiving to Cloudflare R2, with a restore tested before Phase 5 handles real money — not deferred to the Phase 11 disaster-recovery exercise, which is after money is already flowing.

Staging and production share one box initially. This softens the environment isolation BRD §12.4 requires and is recorded as a known limitation, resolved by a second VPS when it starts to matter.

Production database choice is deliberately deferred to just before Phase 5. Through Phase 4 there is no real money, so losing the database costs a rebuild. From Phase 5 the calculus changes and managed Postgres with point-in-time recovery is worth £15–25/month.

## Consequences

Predictable, low cost, and no cloud-provider learning curve competing with product work.

We own durability entirely until the Phase 5 decision. That obligation is why the off-box backup requirement is stated as non-negotiable rather than as a task.

Shared staging and production means a bad migration or a runaway process can affect both. Acceptable at pilot scale, not beyond it.

Prisma behind a repository layer keeps the database a connection string, so migrating to a managed provider later is a configuration change plus a data move — not a rewrite. ADR 0004's `btree_gist` dependency constrains which providers qualify, and must be checked before choosing.

## Alternatives considered

**AWS with Terraform, per the BRD.** The best long-term story and the wrong Phase 0. The BRD explicitly states the stack is a recommendation, not a hard dependency.

**Vercel plus Railway.** My original recommendation: managed Postgres and Redis out of the box, trivial staging environments, roughly the same monthly cost. Rejected by the product owner in favour of cost predictability, which is a legitimate call — the trade is our time against their money, and it is their money.

**Managed Postgres from day one.** Removes the durability obligation immediately but spends £15–25/month for months before there is anything worth protecting. Deferring the decision costs a data migration later, which is a known and bounded task.

## What would change this

Phase 5 is the scheduled review point. Any of these should trigger it earlier: a restore drill that fails, sustained resource pressure on one box, or a second engineer joining, at which point shared staging and production stops being tolerable.
