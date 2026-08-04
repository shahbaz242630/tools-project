-- Migration: listing_draft
--
-- Slice 2.4a. The first row a *user* creates rather than an administrator, and
-- the first money stored anywhere in this system (BRD §8.3, §6.2).
--
-- Why the category and its version travel together
-- -----------------------------------------------
-- §6.2 puts both "category" and "category version" on the Listing entity, and
-- both are genuinely needed: the version pins the configuration the listing was
-- written against, and the category is the identity a search filters on without
-- joining through every version ever written.
--
-- Storing them as two independent foreign keys would permit a row claiming
-- category A while pinning a version belonging to category B. Each key would be
-- individually valid, nothing would notice, and the listing would be validated
-- against a schema from a category it does not belong to. That is the
-- second-source-of-truth problem slice 2.1 refused when it declined a
-- `currentVersionId` pointer — except here it would be silent.
--
-- So `category_versions` gains a redundant-looking `UNIQUE (id, categoryId)`,
-- and `listings` takes **one composite foreign key** against that pair. The
-- disagreement becomes unrepresentable rather than merely unlikely, and the
-- denormalised `categoryId` costs nothing to trust.
--
-- Why the value is two columns
-- ----------------------------
-- Integer minor units plus an ISO 4217 code on the same record — ADR 0002 and
-- the money invariant in CLAUDE.md. `INTEGER` not `NUMERIC` or `DOUBLE
-- PRECISION`: pence are whole, and §8.7.1 derives the damage excess from this
-- number, so a rounding error here becomes an amount held on somebody's card.
-- The currency is stored rather than implied by the platform's single supported
-- currency, because the day a second one exists every bare number is ambiguous
-- with nothing left to disambiguate it.
--
-- Why `ON DELETE RESTRICT` on the owner
-- -------------------------------------
-- Prisma's default for a required relation, and correct here. Accounts are
-- soft-deleted (`users.deletedAt`), so it never fires in production — and that
-- is the point: a listing must not disappear from a booking's history because
-- its owner closed their account. It fires in tests, where clearing `users`
-- without clearing this first now fails. **Children before parents, in every
-- `*.db.test.ts` file, not only the new one.**
--
-- Data impact
-- -----------
-- One new table and one new unique index; nothing is rewritten and no existing
-- row changes. The index on `category_versions` is over a pair that is already
-- unique by virtue of `id` alone, so it cannot fail on existing data — the
-- warning Prisma prints about duplicates is unreachable here.
--
-- `status` is written as `DRAFT` by the only code that inserts. There is no
-- CHECK constraint, deliberately: the vocabulary is a closed union in code with
-- an adapter that throws on anything else, exactly as `riskLevel` and
-- `reportableActivity` are. `seller_tax_profiles` is the documented exception,
-- and it is an exception because it has no adapter at all.
--
-- Both tables take a brief ACCESS EXCLUSIVE lock. `listings` is new and nothing
-- reads `category_versions` outside the admin surface and this new join.
--
-- Rollback
-- --------
--   DROP TABLE "listings";
--   DROP INDEX "category_versions_id_categoryId_key";
--
-- Lossless only while no listing exists — which is true until the first owner
-- creates one. From that point it is a roll-forward, because the table holds
-- content somebody wrote and nothing else has a copy of it.

-- CreateTable
CREATE TABLE "listings" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "categoryVersionId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "replacementValueAmount" INTEGER NOT NULL,
    "replacementValueCurrency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listings_ownerId_createdAt_idx" ON "listings"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "category_versions_id_categoryId_key" ON "category_versions"("id", "categoryId");

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_categoryVersionId_categoryId_fkey" FOREIGN KEY ("categoryVersionId", "categoryId") REFERENCES "category_versions"("id", "categoryId") ON DELETE RESTRICT ON UPDATE CASCADE;
