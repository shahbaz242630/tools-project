-- Migration: initial_user
--
-- Data impact: none. Creates a new, empty table. No existing row is read or
-- written, so this is safe to apply to a populated database.
--
-- Rollback: `DROP TABLE "users";` and `DELETE FROM _prisma_migrations WHERE
-- migration_name LIKE '%initial_user';`. Destroys every account, so it is only
-- appropriate before the table holds anything real. From that point forward the
-- correction is a roll-forward migration, never this.
--
-- Rollback of the *application* is safe at any point: this migration only adds,
-- so a previous release that knows nothing about `users` continues to work.
-- That is what expand-and-contract buys and why it is mandatory here.

-- Required by the `email` column below. Declared in the migration rather than
-- assumed from infra/postgres/init: Prisma's shadow database is created empty,
-- and CI and any future environment must build the same schema from migrations
-- alone.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Uniqueness is the database's guarantee, not the application's. Over a citext
-- column this also makes it case-insensitive, so one person cannot hold both
-- alice@example.com and Alice@Example.com.
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
