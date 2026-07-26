---
name: new-migration
description: Write a database migration with the data impact, rollback plan and test BRD §15 requires. Use for any schema change.
---

# New migration

Every migration states its data impact, a rollback or roll-forward plan, and has a test. A migration without a rollback plan is a decision to never revert it.

## Before writing

- What data exists now, and what happens to it?
- Is this destructive? Dropping or narrowing a column loses data that no rollback restores.
- How long will it lock? A table rewrite on a live booking table is an outage.
- Does it need a backfill, and can that run without holding a transaction open?

## Expand and contract

Never rename or drop in one step (BRD §12.4). Three deploys:

1. **Expand** — add the new column, nullable, no constraint. Deploy.
2. **Migrate** — backfill in batches; write to both old and new. Deploy.
3. **Contract** — drop the old column once nothing reads it. Deploy.

Collapsing these means the old code and new schema coexist for the duration of a rollout, and one of them is wrong.

## PostgreSQL specifics for this project

- `CREATE INDEX CONCURRENTLY` on any populated table — a plain `CREATE INDEX` takes an exclusive lock.
- Adding a `NOT NULL` column with a default rewrites the table on older versions. Add nullable, backfill, then constrain.
- Extensions are created in provisioning, not migrations — `CREATE EXTENSION` needs rights the application role must not hold.
- The booking overlap `EXCLUDE` constraint (ADR 0004) needs `btree_gist`. Confirm it is present before a migration depends on it.

## Money and time columns

- Money is an integer minor-unit column plus a currency column. Never `Float`, never `Decimal` (ADR 0002).
- Timestamps are `timestamptz`, always. A `timestamp` without zone silently loses the offset (ADR 0003).

## Required in the pull request

- Data impact, in a sentence.
- Rollback or roll-forward plan.
- Expected lock duration and row count.
- A test proving forward migration preserves existing data.
- Whether a backup should be taken first — mandatory for anything destructive (BRD §12.4).
