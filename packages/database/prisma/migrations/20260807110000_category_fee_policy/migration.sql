-- Migration: category_fee_policy
--
-- Slice 2.7a. What the platform charges becomes versioned configuration
-- (BRD §8.2, §3.4, §6.2).
--
-- Why these live on the version and not on the category
-- ----------------------------------------------------
-- §8.2 requires existing bookings to retain the configuration version under
-- which they were created, and §6.1 makes that binding for any record whose
-- interpretation depends on rules that change over time. A rate stored on
-- `categories` answers "what do we charge now". A payout dispute, a refund or an
-- HMRC question eighteen months later needs "what did we charge *then*", and
-- only this row — which a trigger already refuses to UPDATE — can answer it.
--
-- The same argument that put `reportableActivity` here in slice 2.3, and it is
-- stronger for money: a reinterpreted flag is a compliance problem, a
-- reinterpreted fee rate is somebody's payout being wrong.
--
-- Why columns rather than one JSON blob
-- ------------------------------------
-- `attributes` and `transportOptions` are JSON on this table, so the departure
-- is worth stating. Those are variable-length, ordered, and always read whole.
-- A fee policy is four fixed values that later work queries *across* categories:
-- §3.4.3's contribution-margin gate, Phase 5's payout reconciliation, and any
-- "which categories charge more than X" report. Columns answer those without
-- parsing every row, and Postgres can constrain them — which is the second half
-- of this migration.
--
-- Why basis points
-- ----------------
-- Hundredths of a percent, as an integer. 15% is 1500.
--
-- ADR 0002 bans floats for money. A rate is not money, but it is what money is
-- multiplied by, so a float here lands in the ledger just as surely: `0.15` has
-- no exact binary representation and the error is inherited by every amount it
-- touches before any rounding rule gets a chance to be careful.
--
-- Basis points rather than whole percent because 12.5% is a rate somebody will
-- want, and a percent-granular column forces it to 12 or 13 — a 0.5% error on
-- every booking, introduced by a schema and found by reconciliation.
--
-- Data impact
-- -----------
-- Six columns with defaults. PostgreSQL 11+ stores a non-volatile default in the
-- catalogue rather than rewriting the table, so this is not a rewrite even
-- though every column has one.
--
-- **Existing rows default to charging nothing, and no backfill invents a rate.**
-- That is the third time this phase has made the same call — the attribute
-- schema defaulted to empty and the transport options to none — and here it
-- matters most, because a backfilled 15% would be a fee no administrator agreed
-- to, sitting on an immutable row, indistinguishable from one they did.
--
-- Zero is safe where a guess is not: it charges nobody anything, and §8.2
-- already forbids enabling a category for public booking until §3.4.3's worked
-- example exists. A category still carrying these values cannot reach a renter
-- without somebody having looked at the numbers. Locally that is
-- `outdoor-gardening` and the seeded fixture, which read as unpriced — which is
-- what they are.
--
-- The currency columns default to 'GBP' rather than being nullable. A null
-- currency beside a zero amount would be a second representation of "not set"
-- for a field that already has one, and §6.1 requires the code to sit on the
-- same record as the amount unconditionally.
--
-- Rollback
-- --------
--   ALTER TABLE "category_versions"
--     DROP CONSTRAINT "fee_rates_are_within_bounds",
--     DROP CONSTRAINT "fee_floors_are_not_negative",
--     DROP CONSTRAINT "platform_fee_floor_does_not_exceed_booking_floor";
--   ALTER TABLE "category_versions"
--     DROP COLUMN "ownerCommissionBasisPoints",
--     DROP COLUMN "renterFeeBasisPoints",
--     DROP COLUMN "minimumBookingTotalAmount",
--     DROP COLUMN "minimumBookingTotalCurrency",
--     DROP COLUMN "minimumPlatformFeeAmount",
--     DROP COLUMN "minimumPlatformFeeCurrency";
--
-- Lossless for rows written before this migration, because they carry the
-- defaults and nothing else. **Lossy for any version configured after it**, and
-- silently so: the rates are not recoverable from anywhere else, and a booking
-- priced under them would lose the record of the terms it was made under —
-- which is the exact guarantee §8.2 asks this table to provide. Roll forward
-- once any category has been priced.

-- AlterTable
ALTER TABLE "category_versions"
  ADD COLUMN "ownerCommissionBasisPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "renterFeeBasisPoints"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimumBookingTotalAmount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimumBookingTotalCurrency" TEXT    NOT NULL DEFAULT 'GBP',
  ADD COLUMN "minimumPlatformFeeAmount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "minimumPlatformFeeCurrency"  TEXT    NOT NULL DEFAULT 'GBP';

-- The bounds the contract enforces, held here as well.
--
-- Not belt-and-braces: `MAX_FEE_BASIS_POINTS` is a constant in a TypeScript file
-- somebody can raise in one line, and the thing it guards is how much money the
-- platform takes from a stranger. The same reasoning that put
-- `fuzz_offset_is_within_bounds` in the database in 2.5b — lowering the constant
-- there would quietly publish points nearer people's homes; raising it here
-- would quietly charge more — and in both cases the database refuses the write
-- rather than the change going unnoticed.
--
-- 5000 basis points is 50%, a hard ceiling far above anything §3.4 contemplates.
-- The commercially recommended band (12–20% owner, 5–12% renter) is deliberately
-- *not* here: that is guidance the admin form shows, and a deliberate decision
-- to move outside it must not require a migration.
ALTER TABLE "category_versions" ADD CONSTRAINT "fee_rates_are_within_bounds" CHECK (
  "ownerCommissionBasisPoints" BETWEEN 0 AND 5000
  AND "renterFeeBasisPoints" BETWEEN 0 AND 5000
);

-- A negative floor is not a policy anybody means. Stated separately from the
-- rule below so a violation names which of the two was broken.
ALTER TABLE "category_versions" ADD CONSTRAINT "fee_floors_are_not_negative" CHECK (
  "minimumBookingTotalAmount" >= 0
  AND "minimumPlatformFeeAmount" >= 0
);

-- A minimum platform fee above the minimum booking total describes a category
-- whose smallest permissible booking pays the platform more than the booking is
-- worth, leaving the owner a negative payout. Unreachable by any sensible pair
-- of numbers and one transposed digit away at all times.
--
-- The currencies must agree for the comparison to mean anything. Today there is
-- one currency and this is trivially true; the day there are two, comparing 500
-- pence against 500 cents would silently pass a rule that never fired.
ALTER TABLE "category_versions" ADD CONSTRAINT "platform_fee_floor_does_not_exceed_booking_floor" CHECK (
  "minimumPlatformFeeCurrency" = "minimumBookingTotalCurrency"
  AND "minimumPlatformFeeAmount" <= "minimumBookingTotalAmount"
);
