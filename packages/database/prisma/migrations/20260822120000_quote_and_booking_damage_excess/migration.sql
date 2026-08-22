-- Migration: quote_and_booking_damage_excess
--
-- Slice 5.5b-ii. A quote and a booking record the damage-security excess that
-- was disclosed when they were made — BRD §8.7.2's *"shown to both parties
-- before booking. Bookings retain the values current at creation."*
--
-- Why this is stored and not derived
-- ----------------------------------
-- The applied excess is `f(band, listing.replacement value)`. Slice 5.5a put the
-- band on `category_versions`, which is immutable and already pinned by both
-- these tables — so half the calculation can be reconstructed for ever. **The
-- other half cannot.** `listings.replacementValueAmount` is an ordinary mutable
-- column an owner edits whenever they like, so a booking that recomputed its
-- excess would show today's valuation against last month's hire, and two parties
-- reading the same booking a week apart could see different figures.
--
-- That is §8.2's copy rule, which these tables already apply to the money and to
-- the item's name. The excess is the same kind of fact and gets the same
-- treatment.
--
-- Why the currency is not a column
-- --------------------------------
-- ADR 0002 requires an amount and its ISO 4217 code on the same record. Both
-- tables already carry exactly one `currency` column, shared by
-- `itemChargeAmount`, `renterFeeAmount` and `totalAmount`; the excess joins it
-- rather than bringing its own. A second currency column would make it
-- *representable* for a booking priced in one currency to hold an excess in
-- another, and then need a CHECK to say it must not — where sharing the column
-- makes the disagreement unsayable. (`category_versions` needed
-- `excess_band_currencies_agree` precisely because it has no such shared
-- column.)
--
-- Why `boundBy` is stored rather than recomputed
-- ----------------------------------------------
-- It is the sentence a party is owed about their own money — "£75, our minimum
-- for this kind of item" reads differently from "£75, based on what this item
-- would cost to replace". It is not derivable after the fact for the same reason
-- the amount is not: the replacement value that decided it has moved on.
--
-- Why NULL rather than zero
-- -------------------------
-- ADR 0052. A category may be "configured to require no security", and §8.7.2
-- requires that a deliberately unsecured handover be distinguishable from one
-- whose hold failed. A zero-valued excess would collapse the two into one row
-- shape. NULL means "nothing is held here"; it never means "not calculated".
--
-- Data impact
-- -----------
-- Two nullable columns on each of `quotes` and `bookings`, and one CHECK on
-- each. ADD COLUMN with no DEFAULT is a catalogue-only change in PostgreSQL 11
-- and later, so no existing row is rewritten and no table is rewritten.
--
-- **Every existing quote and booking becomes "no damage security".** That is
-- honest rather than convenient: every category version in existence carries no
-- band (5.5a's own backfill), so no quote or booking that exists was made under
-- one. There is nothing to backfill *from*, and inventing a figure would put a
-- liability on a row a renter already agreed to.
--
-- Rollback
-- --------
-- `ALTER TABLE "quotes" DROP CONSTRAINT "quote_damage_excess_is_complete";`
-- `ALTER TABLE "quotes" DROP COLUMN "damageExcessAmount", DROP COLUMN "damageExcessBoundBy";`
-- and the same two for `bookings`. Both are safe: nothing outside slice 5.5b-ii
-- reads these columns, and dropping them loses only figures that were derivable
-- at the time they were written. Roll forward is preferred once anything has
-- been held against one (5.5c), because from that point the column is the record
-- of what a renter authorised.

-- What the renter was shown when the price was fixed. The renter sees this on
-- the quote; the owner sees the same figure on the request it becomes.
ALTER TABLE "quotes"
  ADD COLUMN "damageExcessAmount"  INTEGER,
  ADD COLUMN "damageExcessBoundBy" TEXT;

-- What the booking retains (§8.7.2), copied from the quote it was made from and
-- never read back through the listing.
ALTER TABLE "bookings"
  ADD COLUMN "damageExcessAmount"  INTEGER,
  ADD COLUMN "damageExcessBoundBy" TEXT;

-- All or nothing, the `damage_security_is_complete` shape one table along: an
-- amount with no explanation is a figure nobody can account for, and an
-- explanation with no amount describes nothing.
--
-- The vocabulary is closed in the database as well as in `EXCESS_BOUNDS`,
-- because these rows outlive the code that wrote them — the same argument
-- `event_is_known` and `regime_is_known` make. A zero amount is legitimate: a
-- band with a zero floor and a percentage of a nearly worthless item rounds to
-- nothing, and that is a hold of £0 rather than no hold at all.
--
-- **`"damageExcessBoundBy" IS NOT NULL` is written out even though `IN` appears
-- to cover it, and removing it silently reopens a hole.** `NULL IN ('floor',
-- 'percentage', 'ceiling')` evaluates to NULL rather than to false, so the
-- second branch became `true AND true AND NULL` = NULL, the whole expression
-- became `false OR NULL` = NULL — **and a CHECK constraint passes on NULL**. It
-- only fails on false. An amount with no explanation was therefore storable on
-- both tables. Found by firing every case by hand in a rolled-back transaction
-- before the tests were written, which is why that habit exists. Each branch
-- states every column's nullness explicitly, exactly as
-- `damage_security_is_complete` does for its five.
ALTER TABLE "quotes" ADD CONSTRAINT "quote_damage_excess_is_complete"
  CHECK (
    ("damageExcessAmount" IS NULL AND "damageExcessBoundBy" IS NULL)
    OR (
      "damageExcessAmount" IS NOT NULL
      AND "damageExcessBoundBy" IS NOT NULL
      AND "damageExcessAmount" >= 0
      AND "damageExcessBoundBy" IN ('floor', 'percentage', 'ceiling')
    )
  );

ALTER TABLE "bookings" ADD CONSTRAINT "booking_damage_excess_is_complete"
  CHECK (
    ("damageExcessAmount" IS NULL AND "damageExcessBoundBy" IS NULL)
    OR (
      "damageExcessAmount" IS NOT NULL
      AND "damageExcessBoundBy" IS NOT NULL
      AND "damageExcessAmount" >= 0
      AND "damageExcessBoundBy" IN ('floor', 'percentage', 'ceiling')
    )
  );
