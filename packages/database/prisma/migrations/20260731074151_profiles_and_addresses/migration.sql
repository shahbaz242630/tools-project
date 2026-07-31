-- Migration: profiles_and_addresses
--
-- Adds the Profiles & Trust module's two tables (BRD §5.1, §6.2): a public
-- profile and the postal address behind it.
--
-- Data impact
-- -----------
-- Purely additive. Two new, empty tables. No existing column changes, no
-- backfill, and `users` is not touched beyond gaining two inbound foreign
-- keys. Every existing row is unaffected, so this cannot fail on populated
-- data the way `clerk_identity_mirror` could.
--
-- Locks: `ALTER TABLE users` is not issued. The two `ADD CONSTRAINT` statements
-- take a `SHARE ROW EXCLUSIVE` lock on `users` for the duration of the
-- constraint validation — on an empty or small table that is sub-millisecond,
-- and it blocks writes rather than reads. At current row counts (zero deployed,
-- a handful locally) this is immeasurable. Worth revisiting only if a later
-- migration adds a foreign key to `users` once it holds real volume.
--
-- Expand-and-contract
-- -------------------
-- Not applicable: nothing is renamed, narrowed or dropped. New tables that no
-- previous release reads are the one case where a single deploy is safe by
-- construction — the old code cannot observe them.
--
-- Application rollback: safe. The previous release contains no code referencing
-- either table, so rolling back across this migration changes nothing it can
-- see. Rolling *forward* over a rollback is equally safe.
--
-- Schema rollback:
--   DROP TABLE "addresses";
--   DROP TABLE "profiles";
--   DELETE FROM _prisma_migrations
--     WHERE migration_name LIKE '%profiles_and_addresses';
--
-- Backup first? Not required — BRD §12.4 mandates one before anything
-- destructive, and this drops nothing. The rollback above *is* destructive, so
-- a backup is mandatory before running that against a database holding rows.
--
-- On encryption
-- -------------
-- `addresses.encryptedDetail` holds an AES-256-GCM envelope, not plaintext, and
-- the key lives outside the database in PERSONAL_DATA_ENCRYPTION_KEY. Restoring
-- this table from a backup without that key restores unreadable rows. That is
-- the intended trade (ADR 0016) and it makes the key part of the backup plan,
-- not an application detail.

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "postcode" TEXT NOT NULL,
    "outwardCode" TEXT NOT NULL,
    "town" TEXT NOT NULL,
    "encryptedDetail" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_userId_key" ON "profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_userId_key" ON "addresses"("userId");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
