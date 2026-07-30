-- Migration: clerk_identity_mirror
--
-- Turns `users` into a mirror of the Clerk identity directory (ADR 0015) and
-- adds the webhook-event ledger that makes mirroring idempotent.
--
-- Data impact
-- -----------
-- `role` is added NOT NULL with a DEFAULT, so any existing row backfills to
-- 'USER'. `deletedAt` is nullable. `webhook_events` is a new, empty table.
--
-- `clerkUserId` is added **NOT NULL with no default, and that is deliberate.**
-- On a table holding rows this statement fails outright. There is no honest
-- default available: a platform account with no Clerk identity cannot be
-- authenticated, and inventing a placeholder would produce a row that silently
-- never logs in. Failing loudly is the correct behaviour.
--
-- No deployed database holds a row, because nothing is deployed at all and ADR
-- 0009's durability gate forbids real data until off-box backups exist. CI is
-- equally safe: its Postgres is a fresh service container per run. The one
-- database that *does* accumulate rows is the local integration-test database,
-- which the suite is free to truncate — applying this there requires
-- `TRUNCATE TABLE users CASCADE;` first. That is the guard working, not a
-- defect in it.
--
-- Note for whoever hits that: `prisma migrate deploy` does **not** wrap a
-- migration in a transaction, so this one half-applies — `CREATE TYPE` commits,
-- the `ALTER TABLE` fails, and the type is left behind. Recovery is
-- `DROP TYPE "UserRole";` plus
-- `prisma migrate resolve --rolled-back 20260730064820_clerk_identity_mirror`
-- before retrying. Assuming migrations are atomic will cost you the same
-- twenty minutes it cost to write this paragraph.
--
-- Expand-and-contract
-- -------------------
-- A NOT NULL column with no default is normally a contract-phase step and would
-- need expand → backfill → enforce across three deploys. That sequence exists to
-- protect rows and a running previous release; here there are neither. Stated
-- explicitly so the shortcut is visible as a judgement about *this* table rather
-- than read as the pattern to copy onto a populated one.
--
-- Application rollback: safe. The previous release contains no code that reads
-- or writes `users` at all — the table was created in `initial_user` and has
-- been unused since — so rolling the application back across this migration
-- changes nothing it can observe.
--
-- Schema rollback (only while the table is empty; a roll-forward migration
-- otherwise):
--   DROP TABLE "webhook_events";
--   DROP INDEX "users_clerkUserId_key";
--   ALTER TABLE "users"
--     DROP COLUMN "clerkUserId", DROP COLUMN "deletedAt", DROP COLUMN "role";
--   DROP TYPE "UserRole";
--   DELETE FROM _prisma_migrations
--     WHERE migration_name LIKE '%clerk_identity_mirror';

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "clerkUserId" TEXT NOT NULL,
ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateTable
--
-- The idempotency ledger. Deliberately carries no payload column: the delivery
-- identifier is all that exactly-once processing needs, and the Clerk body
-- holds email addresses we would otherwise be storing a second time, outside
-- `users`, with no purpose and no retention rule (BRD §10, data minimisation).
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The idempotency guarantee itself, and it is the database's rather than the
-- application's on purpose. Two API containers receiving the same retry
-- concurrently both pass any "have I seen this?" check written in code; only a
-- unique constraint makes the second insert fail.
--
-- Scoped by provider because Stripe arrives in Phase 5 and event identifiers
-- are only unique within the provider that issued them.
CREATE UNIQUE INDEX "webhook_events_provider_externalId_key" ON "webhook_events"("provider", "externalId");

-- CreateIndex
--
-- One platform account per Clerk user. Without this, a duplicated webhook
-- delivery that raced the uniqueness check in application code would create a
-- second mirror row, and "which account is this request" would have two answers
-- at precisely the point where it must have one.
CREATE UNIQUE INDEX "users_clerkUserId_key" ON "users"("clerkUserId");
