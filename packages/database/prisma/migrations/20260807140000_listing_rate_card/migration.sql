-- Migration: listing_rate_card
--
-- Slice 2.7b. A listing gains what it costs to rent (BRD §8.5.2, §8.3).
--
-- Why three rates and not five
-- ----------------------------
-- §8.5.2 names "daily, hourly, weekend, weekly and configurable discounts".
-- Daily, weekend and weekly are here.
--
-- **Hourly is deliberately absent.** In a peer-to-peer model the renter drives
-- to a stranger's house to collect the item and drives back to return it, so the
-- round trip exceeds the rental, and nothing in the launch category is hired by
-- the hour. An unused rate is not free: it is a case the quote engine, the
-- booking summary, the payout calculation and the handover checklist each carry
-- forever, and a field on the listing form that makes an owner wonder whether
-- they were supposed to fill it in. It is one column and one form field away if
-- a later category wants it, and adding it then is cheaper than carrying it now.
--
-- **Configurable discounts are absent for a different reason.** A discount
-- applies to a duration, and Phase 2 has no dates. They belong with the quote
-- engine in Phase 4, where there is a period to discount.
--
-- Why one currency column for three amounts
-- -----------------------------------------
-- §6.1 requires the ISO 4217 code on the same record as the amount, and it is —
-- for the record as a whole. Three separate currency columns would make it
-- representable for one listing to carry a daily rate in pounds and a weekly one
-- in euros, which is not a state anything downstream could price and which no
-- interface would offer. Fewer columns, one fewer impossible state.
--
-- Why the CHECK
-- -------------
-- `rate_card_has_a_daily_rate_if_it_has_any` refuses a weekend or weekly rate
-- with no daily rate beside it. Such a row describes an item that can be rented
-- for three days but not for one, with nothing on the listing saying so — the
-- quote engine has no way to express it and 2.8's publication rule would have to
-- invent a meaning for it. The daily rate is the spine; the others are
-- alternatives to it, not replacements for it.
--
-- What is deliberately **not** checked: that a weekly rate is less than seven
-- daily charges, or a weekend less than three. A rate card is the owner's
-- commercial decision, and a constraint second-guessing it would hard-code a
-- pricing opinion in the database (§1.2). What is refused is only what cannot be
-- interpreted.
--
-- Data impact
-- -----------
-- Three nullable columns and one with a default. PostgreSQL 11+ stores a
-- non-volatile default in the catalogue rather than rewriting the table.
--
-- **Every existing listing reads as unpriced, truthfully.** Locally that is the
-- six drafts from 2.4 and 2.5; there is no deployed environment. No backfill
-- invents a rate — the same call the attribute schema, the transport options and
-- the fee policy each made, and the same reason: a price nobody chose is
-- indistinguishable from one they did, and this one is what a stranger would
-- be charged.
--
-- The CHECK is satisfied by every existing row, because all three amounts are
-- null and the rule only bites when one of the other two is set.
--
-- Rollback
-- --------
--   ALTER TABLE "listings"
--     DROP CONSTRAINT "rate_card_has_a_daily_rate_if_it_has_any";
--   ALTER TABLE "listings"
--     DROP COLUMN "dailyRateAmount",
--     DROP COLUMN "weekendRateAmount",
--     DROP COLUMN "weeklyRateAmount",
--     DROP COLUMN "rateCurrency";
--
-- Lossless for rows written before this migration. **Lossy for any listing
-- priced after it**, and the loss is the owner's commercial decision, which
-- exists nowhere else. Roll forward once any listing carries a rate.

-- AlterTable
ALTER TABLE "listings"
  ADD COLUMN "dailyRateAmount"   INTEGER,
  ADD COLUMN "weekendRateAmount" INTEGER,
  ADD COLUMN "weeklyRateAmount"  INTEGER,
  ADD COLUMN "rateCurrency"      TEXT NOT NULL DEFAULT 'GBP';

-- The daily rate is the spine. Named so a violation says which rule was broken,
-- the way `location_is_geocoded_or_not` and `fee_rates_are_within_bounds` do.
ALTER TABLE "listings" ADD CONSTRAINT "rate_card_has_a_daily_rate_if_it_has_any" CHECK (
  "dailyRateAmount" IS NOT NULL
  OR ("weekendRateAmount" IS NULL AND "weeklyRateAmount" IS NULL)
);

-- Sanity bounds, matching `rentalRateSchema` in @platform/contracts.
--
-- Held here as well for `fee_rates_are_within_bounds`' reason: the constants are
-- in a TypeScript file somebody can widen in one line, and what they guard is
-- the number a stranger is charged. The easy mistake is entering pounds where
-- pence are meant — a factor of a hundred — which this catches at both ends.
--
-- Platform-wide sanity, not policy: a per-category cap belongs in category
-- configuration beside the deposit bands §8.2 already promises.
ALTER TABLE "listings" ADD CONSTRAINT "rental_rates_are_within_bounds" CHECK (
  ("dailyRateAmount"   IS NULL OR "dailyRateAmount"   BETWEEN 100 AND 1000000)
  AND ("weekendRateAmount" IS NULL OR "weekendRateAmount" BETWEEN 100 AND 1000000)
  AND ("weeklyRateAmount"  IS NULL OR "weeklyRateAmount"  BETWEEN 100 AND 1000000)
);
