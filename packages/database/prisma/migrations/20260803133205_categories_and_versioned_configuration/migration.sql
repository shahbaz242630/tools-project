-- Migration: categories_and_versioned_configuration
--
-- Slice 2.1, and the first tables of the Catalogue module (BRD §5.1). A rental
-- category, and the immutable snapshots of its configuration.
--
-- Why two tables
-- --------------
-- BRD §1.2 makes the platform category-agnostic: categories, fees, attributes,
-- radii, deposits and policies are versioned configuration, never code. §8.2
-- adds the constraint that makes it real — "Configuration changes are versioned
-- and audited; existing bookings retain the configuration version under which
-- they were created."
--
-- A booking cannot pin a value stored where it can be overwritten. So
-- `categories` holds only what never changes — the slug, which is the URL and
-- the SEO identity §8.17 needs to keep canonical — and every configurable fact
-- lives on `category_versions`, written once and never touched again. From
-- Phase 4 a booking carries a category version reference and reads its fees and
-- rules from that row forever, whatever an administrator changes afterwards.
--
-- Why there is no `current_version_id` on `categories`
-- ---------------------------------------------------
-- The current configuration is the row with the highest `versionNumber` for the
-- category, found by an index seek on the unique constraint below — a btree
-- scans backwards, so "latest" is not a table scan. A pointer column would be a
-- cycle between two required foreign keys, insertable only with deferred
-- constraints and modelled badly by Prisma; worse, it would be a second source
-- of truth that can disagree with the rows it points at. This way there is
-- exactly one way to answer "what is current", and it cannot go stale.
--
-- The unique constraint is also the concurrency control. Two administrators
-- saving at the same moment compute the same next version number, and the
-- second INSERT fails on the constraint rather than silently overwriting the
-- first.
--
-- Immutability is enforced here, not only in the port
-- --------------------------------------------------
-- `AuditLog`'s immutability is a property of its TypeScript port: there is no
-- update method, so nothing can call one (ADR 0017). That works, but the port
-- is exactly the file somebody edits when they need to "just correct" a value,
-- and configuration that bookings are interpreted under deserves a guarantee
-- that survives a plausible-looking pull request.
--
-- So UPDATE is refused by a trigger. **DELETE deliberately is not.** Test
-- teardown removes rows, and from Phase 4 the thing that will actually hold a
-- referenced version in place is a booking's foreign key — a real constraint
-- expressing a real dependency, rather than a blanket prohibition. Refusing
-- DELETE here would buy nothing and break every integration test's `beforeEach`.
--
-- Data impact
-- -----------
-- Two new tables, both empty. Nothing existing is read or rewritten. `users` and
-- the new `categories` each take a brief ACCESS EXCLUSIVE lock while their
-- foreign key is added, which at this size is instant.
--
-- `category_versions.createdById` references `users` ON DELETE RESTRICT, so an
-- account cannot be removed while it authored a configuration. Accounts are
-- soft-deleted rather than removed (see `users.deletedAt`), so this constrains
-- nothing in practice — but it does mean **every `*.db.test.ts` that clears
-- `users` must now clear `category_versions` first**. Children before parents,
-- in every file, not only the new one.
--
-- Rollback
-- --------
--   DROP TRIGGER IF EXISTS category_versions_are_immutable ON "category_versions";
--   DROP FUNCTION IF EXISTS refuse_category_version_update();
--   DROP TABLE IF EXISTS "category_versions";
--   DROP TABLE IF EXISTS "categories";
--
-- Lossless while nothing references a category, which is true until slice 2.4.
-- After that, roll forward rather than back: dropping these tables would take
-- the configuration every listing and booking is interpreted under with them.

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_versions" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "category_versions_categoryId_versionNumber_key" ON "category_versions"("categoryId", "versionNumber");

-- AddForeignKey
ALTER TABLE "category_versions" ADD CONSTRAINT "category_versions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_versions" ADD CONSTRAINT "category_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A configuration snapshot that can be edited is not a snapshot.
--
-- Raises rather than silently ignoring the write: a caller that believed it
-- updated a row has to find out that it did not. The message names the version
-- and the category because the caller that hits this is a bug, and the useful
-- question is always "which one did you think you were editing".
CREATE OR REPLACE FUNCTION refuse_category_version_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'category_versions rows are immutable — mint a new version rather than editing version % of category %',
    OLD."versionNumber", OLD."categoryId"
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER category_versions_are_immutable
  BEFORE UPDATE ON "category_versions"
  FOR EACH ROW
  EXECUTE FUNCTION refuse_category_version_update();
