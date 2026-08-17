-- Migration: quotes
--
-- Slice 4.4b. The `Quote` record BRD §8.5.2 and §6.2 require: a priced, expiring
-- offer for a period, with the renter's postcode and the category version it was
-- priced under, "so the quote can be reproduced and audited".
--
-- Why a price is stored at all
-- ---------------------------
-- The arithmetic is deterministic, so a price could be recomputed on demand —
-- and recomputing answers a different question. It answers what we *would* say
-- now, which is exactly what a dispute is not about. §8.5.2 is explicit that the
-- postcode, the expiry and the category version are stored, and those three are
-- what turn a number into a thing we said.
--
-- Why it has a renter, when §6.2's entity list does not
-- ----------------------------------------------------
-- §6.2 lists "Listing, dates, **renter postcode**, line items, total…" and never
-- names a renter. Taken literally that permits an anonymous visitor to leave a
-- postcode and a date range in this table with nobody who could ask for it back
-- — personal data with no subject and therefore no erasure route, which §10.1
-- does not allow. So a quote requires a signed-in renter, and `renterId` is NOT
-- NULL. Nothing is lost: a stranger still sees the indicative `from £x/day` on
-- the listing page, which §8.5.2 explicitly permits before a postcode is given.
--
-- Why three different ON DELETE rules on one table
-- -----------------------------------------------
-- Each answers "whose record is this?", which is the question that decided the
-- same three for `bookings` and `availability_blocks`:
--
--   listingId         CASCADE   An offer for an item that no longer exists means
--                               nothing. Matches `availability_blocks`.
--   renterId          CASCADE   A quote has no counterparty. Nobody else's record
--                               depends on a price offered to somebody who never
--                               acted on it, and it holds their postcode — so
--                               erasing the account erases it. This is the
--                               erasure decision of 17 August 2026: an unused
--                               quote is erased outright.
--   categoryVersionId RESTRICT  The configuration a price was given under cannot
--                               be deleted while the price still exists to be
--                               explained. `category_versions` refuses UPDATE by
--                               trigger but deliberately still permits DELETE
--                               (slice 2.1), so this is a real guard.
--
-- **Both cascades invert in slice 4.5**, when a booking references a quote: the
-- quote becomes part of that booking's terms, the *counterparty* acquires a right
-- to them, and accounts are soft-deleted (ADR 0018) precisely so a counterparty
-- can never be lost. That is the same inversion the 10 August listing-deletion
-- decision predicted and that slice 4.2 already performed once, when
-- `deleteAllOwnedBy` became `eraseOwnedBy`.
--
-- What is deliberately absent
-- ---------------------------
-- **No `period` range and no EXCLUDE constraint**, unlike `bookings` and
-- `availability_blocks`. A quote reserves nothing (§7.1) — two people may hold
-- quotes for the same week and only acceptance decides between them, so a range
-- here would suggest a guarantee that does not exist. This is also why there is
-- no `btree_gist` dependency and no trigger.
--
-- **No `updatedAt`.** Nothing updates a quote; re-pricing is a new quote. A
-- column implying otherwise would be an invitation.
--
-- **No damage-security, protection-fee or tax columns**, though §8.5.2 names all
-- three as quote outputs. Deposit bands do not exist on `category_versions` yet,
-- protection is Phase 10, and tax does not apply to the launch category. A zero
-- column would assert "no deposit" and "no tax" — claims this platform is not in
-- a position to make — where an absent column is visibly not yet built.
--
-- Data impact
-- -----------
-- One new table, three indexes, three foreign keys. **No existing row is read or
-- written**, and nothing outside this table changes, so there is no backfill and
-- no lock on any table that has data in it. The three foreign keys take a brief
-- SHARE ROW EXCLUSIVE lock on `listings`, `users` and `category_versions` while
-- they are validated against an empty child table.
--
-- Rollback
-- --------
--   DROP TABLE "quotes";
--
-- **Safe in both directions today, and it will not stay that way.** Nothing
-- references a quote until slice 4.5, so dropping the table loses only prices
-- nobody acted on. From 4.5 a quote carries the terms a booking was made under,
-- and §8.2 requires a booking to keep them — so the answer becomes roll forward.

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "renterId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "timeZone" TEXT NOT NULL,
    "renterPostcode" TEXT NOT NULL,
    "itemChargeAmount" INTEGER NOT NULL,
    "renterFeeAmount" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "minimumFeeApplied" BOOLEAN NOT NULL,
    "lineItems" JSONB NOT NULL,
    "categoryVersionId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- A hire of at least a moment, and money that cannot be negative.
--
-- **Invisible to Prisma, like every CHECK in this schema** (`suspension_is_complete`,
-- `location_is_geocoded_or_not`, `maximum_rental_days_is_lawful`). The
-- application refuses all of these long before the database sees them —
-- `refusePeriod` for the ordering, `Money` for the amounts — and the point of
-- putting them here is that a future writer who has not read that code still
-- cannot store nonsense.
--
-- `endAt > startAt` rather than `>=`: the columns are a half-open range and an
-- empty one is not a hire, which is the same rule `refusePeriod` calls
-- "inverted".
ALTER TABLE "quotes" ADD CONSTRAINT "quote_period_is_a_hire"
  CHECK ("endAt" > "startAt");

-- Money is integer minor units and none of these three may be negative (ADR
-- 0002). The total is stored rather than derived — it is the number a person was
-- shown and §3.4.4 makes it the legally significant one — so the relationship
-- between the three is asserted here rather than assumed.
ALTER TABLE "quotes" ADD CONSTRAINT "quote_money_is_not_negative"
  CHECK (
    "itemChargeAmount" >= 0
    AND "renterFeeAmount" >= 0
    AND "totalAmount" = "itemChargeAmount" + "renterFeeAmount"
  );

-- The line items are what explain the price, so an empty array is a quote that
-- cannot be explained. A JSON array specifically: `jsonb_typeof` refuses an
-- object or a bare number, which is what an accidental single line item would
-- serialise as.
ALTER TABLE "quotes" ADD CONSTRAINT "quote_has_line_items"
  CHECK (jsonb_typeof("lineItems") = 'array' AND jsonb_array_length("lineItems") > 0);

-- CreateIndex
CREATE INDEX "quotes_renterId_createdAt_idx" ON "quotes"("renterId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "quotes_listingId_createdAt_idx" ON "quotes"("listingId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "quotes_expiresAt_idx" ON "quotes"("expiresAt");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "listings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_renterId_fkey"
  FOREIGN KEY ("renterId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_categoryVersionId_fkey"
  FOREIGN KEY ("categoryVersionId") REFERENCES "category_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
