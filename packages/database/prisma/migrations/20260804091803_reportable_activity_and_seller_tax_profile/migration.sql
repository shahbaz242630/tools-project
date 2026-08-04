-- Migration: reportable_activity_and_seller_tax_profile
--
-- Slice 2.3. Two things BRD §8.14.2 requires together: the flag that decides
-- whether a category's activity is reportable to HMRC, and the entity where a
-- reportable seller's tax data would live — present, and inactive.
--
-- Why the flag is on the version and not on the category
-- -----------------------------------------------------
-- §8.2 requires a booking to be interpreted under the configuration in force
-- when it was made, and §8.14.2 makes this the one configuration value that can
-- change the platform's regulatory status. A flag on `categories` answers "is
-- this category reportable now"; a return has to answer "was this activity
-- reportable when it happened". Only the version can answer the second, and the
-- version is already immutable by trigger, so the answer cannot be rewritten
-- after the fact.
--
-- TEXT with the union in code, exactly as `riskLevel` and `AuditLog.action` are.
-- An enum would put every future statutory head behind a schema migration, and
-- the adapter already throws on a value it does not recognise rather than
-- defaulting — which is the right direction to fail for something that decides
-- whether we owe HMRC a return.
--
-- Why `seller_tax_profiles` has no personal-data columns
-- -----------------------------------------------------
-- §6.2 lists "collected fields" on this entity. Those fields are a name, an
-- address, a date of birth and a taxpayer reference: personal data, which in
-- this codebase means a table that `PersonalDataEraser` erases and that both
-- `PersonalDataSource` projections expose. **Nothing enumerates the tables that
-- hold personal data.** A fourth one created now would be silently missing from
-- erasure and from the data export, and would stay missing until somebody
-- noticed — which is the failure mode ADR 0018 and ADR 0025 were both written
-- about.
--
-- So the entity carries only what is true of it while it is inactive: whose it
-- is, which regime applies, and how far verification has got. The collected
-- fields are the expand step, and they arrive with the flow that reads them and
-- the eraser that clears them. §8.14.2 asks for the entity to exist so the
-- obligation is "a configuration switch, not a rebuild"; it does not ask us to
-- pre-build a personal-data store for data we have no lawful basis to hold.
--
-- Two CHECK constraints, which is unusual here and deliberate
-- ----------------------------------------------------------
-- Closed vocabularies in this codebase normally live in TypeScript, because an
-- enum makes every new value a migration. This table is the exception, for the
-- reason that makes it exceptional: **there is no code.** No port, no service,
-- no adapter, nothing that could refuse a bad value on the way in. Until it
-- activates, the constraint is the only thing standing between the table and
-- whatever the first writer assumes. Same precedent as `event_is_known` on
-- `authentication_events`.
--
-- Data impact
-- -----------
-- One column and one empty table.
--
-- `ADD COLUMN ... DEFAULT 'none'` is a catalogue-only change in PostgreSQL 11
-- and later: existing rows are not rewritten and the default is materialised on
-- read. At our size it would be instant either way.
--
-- **Existing versions become `none`, and that is a statement of fact rather than
-- a convenient default.** §8.14.1 determined that rental of general goods is not
-- a Relevant Activity — not a Relevant Service, not a means of transport, not a
-- Personal Service, not a sale of goods — so every category configured before
-- this migration was genuinely outside scope, and no backfill is guessing.
--
-- `seller_tax_profiles` is created empty and stays empty. Nothing writes it, no
-- route reaches it, and no category is flagged in a way that would require a
-- row. That is the specified state (§8.14.2), not an unfinished one.
--
-- **The immutability trigger on `category_versions` is unaffected.** It is
-- `BEFORE UPDATE ... FOR EACH ROW`, and DDL does not fire row-level triggers, so
-- adding a column neither trips it nor needs exempting from it. The db test
-- asserts that rather than trusting the reasoning.
--
-- Both tables take a brief ACCESS EXCLUSIVE lock. Nothing reads categories
-- outside the admin surface, and nothing reads the new table at all.
--
-- Rollback
-- --------
--   DROP TABLE "seller_tax_profiles";
--   ALTER TABLE "category_versions" DROP COLUMN "reportableActivity";
--
-- Lossless today: the table is empty, and every existing version is `none`,
-- which is what the absence of the column meant. It stops being lossless the
-- moment any category is flagged non-`none` — at which point dropping the column
-- discards the record of which regime a past booking fell under, and the answer
-- becomes roll forward. Enabling a reportable category is gated on counsel
-- (§8.14.2), so there is a human in that path either way.

-- AlterTable
ALTER TABLE "category_versions" ADD COLUMN     "reportableActivity" TEXT NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "seller_tax_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "regime" TEXT NOT NULL,
    "verificationState" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seller_tax_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_tax_profiles_userId_key" ON "seller_tax_profiles"("userId");

-- AddForeignKey
ALTER TABLE "seller_tax_profiles" ADD CONSTRAINT "seller_tax_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The one reporting regime that exists, and nothing else. Not generated by
-- Prisma. See the note above on why this table carries its rules in the
-- database: no application code exists to enforce them.
ALTER TABLE "seller_tax_profiles" ADD CONSTRAINT "regime_is_known"
    CHECK ("regime" IN ('uk_dprr'));

-- How far verification has got (§6.2). Provisional while the table is empty —
-- widening it costs a migration on nothing.
ALTER TABLE "seller_tax_profiles" ADD CONSTRAINT "verification_state_is_known"
    CHECK ("verificationState" IN ('not_started', 'pending', 'verified', 'failed'));
