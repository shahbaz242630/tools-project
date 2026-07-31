-- Migration: audit_log
--
-- Adds the append-only audit trail (BRD §6.2, §17 risk table). ADR 0017.
--
-- Data impact
-- -----------
-- Purely additive: one new, empty table. No existing column changes, no
-- backfill. `users` gains one inbound foreign key and is otherwise untouched,
-- so every existing row is unaffected.
--
-- Locks: `ADD CONSTRAINT` takes a SHARE ROW EXCLUSIVE lock on `users` while it
-- validates — sub-millisecond at any row count we have, and it blocks writes
-- rather than reads.
--
-- Expand-and-contract
-- -------------------
-- Not applicable: nothing renamed, narrowed or dropped. A new table no previous
-- release reads is safe in a single deploy by construction.
--
-- Application rollback: safe. The previous release contains no code referencing
-- this table, so rolling back across this migration changes nothing it can see.
--
-- Schema rollback:
--   DROP TABLE "audit_logs";
--   DELETE FROM _prisma_migrations WHERE migration_name LIKE '%audit_log';
--
-- Backup first? Not required — this drops nothing. The rollback above is
-- destructive and *does* require one against a database holding rows, and for
-- this table in particular: §10.1 retains security logs a year hot and six
-- years cold, so dropping it discards evidence with a retention obligation
-- attached.
--
-- On ON DELETE SET NULL
-- ---------------------
-- Prisma's default for a nullable relation, and correct here for a reason worth
-- stating: accounts are soft-deleted, so this should never fire. If a hard
-- delete ever does reach `users`, an audit trail that loses the *entry* is far
-- worse than one that loses the actor's name — the record of what happened
-- survives, anonymised, which is what a retention obligation actually needs.
-- Contrast `profiles`, which uses RESTRICT because an orphan profile is
-- meaningless rather than merely less useful.

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "beforeHash" TEXT,
    "afterHash" TEXT,
    "ipAddress" INET,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
