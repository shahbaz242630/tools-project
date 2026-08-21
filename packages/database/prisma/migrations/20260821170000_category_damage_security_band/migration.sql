-- Migration: category_damage_security_band
--
-- Slice 5.5a. A category version gains BRD §8.7.2's three-part excess model as
-- versioned configuration: an excess floor, an excess percentage of the
-- listing's replacement value, and a per-booking recovery ceiling.
--
-- Why three values and not a flat deposit band
-- -------------------------------------------
-- §8.7.2 rejects flat bands outright, and states the reason: a single category
-- holds both a £40 sander and a £900 breaker, and one deposit figure is either
-- absurd for the first or useless for the second. Established UK hire operators
-- express renter liability as the *greater* of a fixed floor and a percentage of
-- replacement value, capped by a recovery ceiling. The same structure is adopted
-- here, and the whole of it is category configuration rather than code, because
-- §1.2 says anything that can change without a deploy is configuration.
--
-- Why all five columns are nullable, together
-- -------------------------------------------
-- §8.7.2 permits a category "configured to require no security", so the absence
-- of a band is a real configuration rather than an unfinished one. ADR 0052
-- records the decision to express that as all five columns being NULL rather
-- than as a boolean beside optional values: a boolean would default to `false`
-- on exactly the pre-existing rows we would want it to be honest about, while
-- adding a second invalid combination (`true` with no values) for a CHECK to
-- exclude anyway.
--
-- `damage_security_is_complete` is the same all-or-nothing shape as
-- `location_is_complete` on `listings` and `suspension_is_complete` on `users`.
-- The invalid middle — a ceiling with no floor, a percentage with no ceiling —
-- is unstorable rather than merely discouraged.
--
-- Why the currencies are columns rather than assumed
-- --------------------------------------------------
-- ADR 0002: an amount and its ISO 4217 code live on the same record. Two amounts
-- means two codes, and `excess_band_currencies_agree` keeps them equal, so a
-- band cannot be half in pence and half in something else.
--
-- Data impact
-- -----------
-- Five nullable columns and two CHECKs. ADD COLUMN with no DEFAULT is a
-- catalogue-only change in PostgreSQL 11 and later; no existing row is
-- rewritten.
--
-- **Every existing version becomes "no damage security", and that is deliberate
-- rather than convenient.** This takes slice 2.2's treatment of the attribute
-- schema and 2.7a's of the fee policy — default to nothing rather than invent
-- configuration nobody chose — and not 4.4a's, which backfilled 88 because
-- §8.5.3 named a right answer. §8.7.2 names no default band, and a backfilled
-- excess would be a liability an administrator never agreed to, sitting on an
-- immutable row, indistinguishable from one they did.
--
-- The cost is stated in ADR 0052 rather than hidden: on a row written before
-- this migration, "nobody configured it" and "we chose to require none" read
-- identically. Two such rows exist, both in local development, and the
-- administrative form refuses to write a third — it makes the choice explicit
-- and offers no default.
--
-- **Nothing enforces damage security yet**, so this changes no behaviour today.
-- Slice 5.5c is where an unset band becomes the difference between a secured
-- handover and an unsecured one.
--
-- **The immutability trigger is unaffected.** It is `BEFORE UPDATE ... FOR EACH
-- ROW`, and DDL does not fire row-level triggers, so this needs no exemption
-- from it and the trigger still refuses an UPDATE the moment this finishes. The
-- db test asserts both halves rather than trusting the reasoning.
--
-- The table takes a brief ACCESS EXCLUSIVE lock. There are two categories.
--
-- Rollback
-- --------
--   ALTER TABLE "category_versions" DROP CONSTRAINT "excess_band_currencies_agree";
--   ALTER TABLE "category_versions" DROP CONSTRAINT "damage_security_is_complete";
--   ALTER TABLE "category_versions"
--     DROP COLUMN "excessFloorAmount",
--     DROP COLUMN "excessFloorCurrency",
--     DROP COLUMN "excessPercentageBasisPoints",
--     DROP COLUMN "recoveryCeilingAmount",
--     DROP COLUMN "recoveryCeilingCurrency";
--
-- Safe while nothing reads the band — true until slice 5.5b puts it on a quote.
-- After that a rollback would discard configuration an administrator entered and
-- a renter was shown, so the answer becomes roll forward.

-- AlterTable
ALTER TABLE "category_versions"
  ADD COLUMN "excessFloorAmount"           INTEGER,
  ADD COLUMN "excessFloorCurrency"         TEXT,
  ADD COLUMN "excessPercentageBasisPoints" INTEGER,
  ADD COLUMN "recoveryCeilingAmount"       INTEGER,
  ADD COLUMN "recoveryCeilingCurrency"     TEXT;

-- All five, or none of them. NULL throughout is §8.7.2's "requires no security".
ALTER TABLE "category_versions" ADD CONSTRAINT "damage_security_is_complete"
  CHECK (
    (
      "excessFloorAmount"           IS NULL
      AND "excessFloorCurrency"         IS NULL
      AND "excessPercentageBasisPoints" IS NULL
      AND "recoveryCeilingAmount"       IS NULL
      AND "recoveryCeilingCurrency"     IS NULL
    )
    OR (
      "excessFloorAmount"           IS NOT NULL
      AND "excessFloorCurrency"         IS NOT NULL
      AND "excessPercentageBasisPoints" IS NOT NULL
      AND "recoveryCeilingAmount"       IS NOT NULL
      AND "recoveryCeilingCurrency"     IS NOT NULL
      -- A floor above the ceiling makes the renter always bear more than could
      -- ever be recovered from them: the two rules contradicting each other on
      -- every booking rather than on an unusual one. Refused in the schema as
      -- well as in the contract because this row outlives the code that wrote it.
      AND "excessFloorAmount" <= "recoveryCeilingAmount"
      -- Zero floor is legitimate — size the excess entirely from the percentage.
      -- Zero ceiling is not: it is a band nothing is recoverable through, which
      -- is the no-security case above, spelled a second way.
      AND "excessFloorAmount"           >= 0
      AND "recoveryCeilingAmount"       >  0
      -- Basis points, never a fraction (ADR 0033). 100% is the ceiling: a renter
      -- cannot owe more than the item is worth.
      AND "excessPercentageBasisPoints" BETWEEN 0 AND 10000
    )
  );

-- ADR 0002 — an amount and its currency travel together, so two amounts cannot
-- disagree about which currency the band is denominated in.
ALTER TABLE "category_versions" ADD CONSTRAINT "excess_band_currencies_agree"
  CHECK ("excessFloorCurrency" IS NOT DISTINCT FROM "recoveryCeilingCurrency");
