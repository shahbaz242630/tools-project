-- Migration: booking_request
--
-- Slice 4.5a. What a request needs before anything can create one: the terms a
-- booking keeps (BRD §8.2, §6.2), the deadline an owner has to answer by (§8.6),
-- and the immutable state history §6.2 calls for.
--
-- Four changes, and one of them inverts a rule this schema shipped yesterday.
--
-- 1. `category_versions.requestExpiryHours`
-- ----------------------------------------
-- §8.6: *"Owner receives notification and accepts or declines before a
-- configurable deadline."* There was no deadline anywhere, so a request could not
-- expire and §14's expiry worker (4.7) would have had nothing to read.
--
-- 48 hours by default — engineering judgement, not BRD text, and bounded by a
-- CHECK between 1 hour and two weeks. An owner here is a private individual with
-- a job: a request arriving on Friday evening has to survive until Monday, which
-- 24 hours does not. A renter who asked for next weekend cannot wait a week to
-- find out, because §17 names low inventory density as the dominant failure mode
-- and a slow no is worse for that than a fast one. The ceiling is commercial
-- rather than legal, so it is generous and exists only to catch a typo — 720
-- hours would leave somebody waiting a month while their dates passed.
--
-- 2. The terms a booking keeps: `bookings` gains nine columns
-- ---------------------------------------------------------
-- The product owner's instruction of 16 August: *"if the booking is done, it
-- should show in history, all details"*. §8.2 requires a booking to keep the
-- terms it was made under, and a booking that rendered its price by joining its
-- listing would show today's price for last month's hire — or nothing at all,
-- because the 10 August decision collapses a listing to its district when its
-- owner leaves.
--
-- So the money, the item's name and its category's name are **copied** at the
-- moment of booking, and the quote and category version they came from are
-- referenced so the copy is provable rather than merely asserted.
--
-- `requestExpiresAt` is named for the request rather than called `expiresAt`
-- deliberately: §7 reaches `EXPIRED` from three states, and those are different
-- deadlines with different lengths and different owners. One column serving all
-- of them would have to be rewritten on every transition, which is how a payment
-- deadline comes to expire a booking as though nobody had answered it.
--
-- 3. `booking_events` — §6.2's immutable state history
-- --------------------------------------------------
-- Deferred from 4.2 to here by the product owner on 16 August, because a table
-- with no writer is a dead control. 4.5a is the first writer.
--
-- **Append-only, enforced by a trigger** refusing UPDATE, exactly as
-- `category_versions` is. That is a stronger guarantee than `audit_logs` has — a
-- port with no update method, which is code rather than storage — and it is
-- warranted because §6.2 uses the word immutable, and a state history that can be
-- edited is evidence of nothing. DELETE is deliberately still permitted, the same
-- call `category_versions` made: retention (§10.1) is a scheduled act.
--
-- 4. The quote erasure inverts, exactly as predicted
-- -------------------------------------------------
-- `quotes.renterId` was `ON DELETE CASCADE` in 4.4b, because nothing referenced a
-- quote and every quote was therefore unused. A booking now carries a quote's
-- terms, and those terms belong to the **counterparty** as much as to the renter —
-- so it becomes `RESTRICT`, and erasure becomes conditional in
-- `QuotesService.eraseFor`: delete the quotes nothing has booked, keep the rest.
--
-- **`quotes.listingId` stays `CASCADE`**, and the asymmetry is the point rather
-- than an oversight — see the note above that statement.
--
-- This is the third time this project has performed the same inversion. The
-- 10 August listing-deletion decision predicted it, `deleteAllOwnedBy` became
-- `eraseOwnedBy` in 4.2 for the same reason, and 4.4b's own migration named it as
-- the change 4.5 would make. The `RESTRICT` is what turns a mistake in that
-- erasure into a failed delete rather than a silently destroyed record.
--
-- Data impact
-- -----------
-- **Nine NOT NULL columns are added to `bookings` with no default, which is only
-- sound because the table is empty**, and this migration asserts that rather than
-- assuming it: the DO block below raises if there is a single row. Nothing creates
-- a booking until this slice's service does — 4.2 built the table and its
-- constraint, and no product path reaches it.
--
-- That is a deliberate departure from expand-and-contract, taken because the
-- alternative on an empty table is three migrations to reach the same shape while
-- leaving a nullable window in which a booking with no price is representable.
-- **On a populated table it would be wrong**, and the guard is what makes that a
-- failure rather than a discovery.
--
-- `requestExpiryHours` is the expand-and-contract case and takes the ordinary
-- treatment: NOT NULL with a DEFAULT, which since PostgreSQL 11 is a
-- catalogue-only change that does not rewrite existing rows.
--
-- Recreating the two `quotes` foreign keys takes a brief ACCESS EXCLUSIVE lock on
-- `quotes` while an empty table is revalidated.
--
-- Rollback
-- --------
--   DROP TRIGGER "booking_events_are_immutable" ON "booking_events";
--   DROP FUNCTION "refuse_booking_event_update"();
--   DROP TABLE "booking_events";
--   ALTER TABLE "bookings"
--     DROP CONSTRAINT "bookings_quoteId_fkey",
--     DROP CONSTRAINT "bookings_categoryVersionId_fkey",
--     DROP CONSTRAINT "booking_money_is_not_negative",
--     DROP COLUMN "quoteId", DROP COLUMN "categoryVersionId",
--     DROP COLUMN "itemChargeAmount", DROP COLUMN "renterFeeAmount",
--     DROP COLUMN "totalAmount", DROP COLUMN "currency",
--     DROP COLUMN "itemTitle", DROP COLUMN "categoryName",
--     DROP COLUMN "requestExpiresAt";
--   ALTER TABLE "category_versions"
--     DROP CONSTRAINT "request_expiry_hours_is_sane",
--     DROP COLUMN "requestExpiryHours";
--   -- and the 4.4b cascade, if going all the way back:
--   ALTER TABLE "quotes" DROP CONSTRAINT "quotes_renterId_fkey",
--     ADD CONSTRAINT "quotes_renterId_fkey" FOREIGN KEY ("renterId")
--     REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--
-- **Safe in both directions only while no booking exists.** The moment one does,
-- rolling back destroys the terms §8.2 requires it to keep and the history §6.2
-- calls immutable — so from the first real request the answer is roll forward.

-- Refuse to run against a populated table, so the NOT NULL adds below cannot
-- silently be the wrong tool. A raise here is a failed migration, which is
-- recoverable; a rewritten table with invented prices is not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bookings") THEN
    RAISE EXCEPTION
      'bookings is not empty: this migration adds NOT NULL columns with no default and needs expand-and-contract instead';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "category_versions"
  ADD COLUMN "requestExpiryHours" INTEGER NOT NULL DEFAULT 48;

-- At least an hour, and at most two weeks. The lower bound is what stops a
-- deadline of zero expiring every request the moment it is made, which reads as a
-- broken platform rather than as a misconfiguration.
ALTER TABLE "category_versions" ADD CONSTRAINT "request_expiry_hours_is_sane"
  CHECK ("requestExpiryHours" BETWEEN 1 AND 336);

-- AlterTable
ALTER TABLE "bookings"
  ADD COLUMN "quoteId" UUID NOT NULL,
  ADD COLUMN "categoryVersionId" UUID NOT NULL,
  ADD COLUMN "itemChargeAmount" INTEGER NOT NULL,
  ADD COLUMN "renterFeeAmount" INTEGER NOT NULL,
  ADD COLUMN "totalAmount" INTEGER NOT NULL,
  ADD COLUMN "currency" TEXT NOT NULL,
  ADD COLUMN "itemTitle" TEXT NOT NULL,
  ADD COLUMN "categoryName" TEXT NOT NULL,
  ADD COLUMN "requestExpiresAt" TIMESTAMPTZ(3) NOT NULL;

-- The same rule `quotes` carries, for the same reason: the total is stored rather
-- than derived because it is what the two parties agreed, so the relationship
-- between the three amounts is asserted rather than trusted.
ALTER TABLE "bookings" ADD CONSTRAINT "booking_money_is_not_negative"
  CHECK (
    "itemChargeAmount" >= 0
    AND "renterFeeAmount" >= 0
    AND "totalAmount" = "itemChargeAmount" + "renterFeeAmount"
  );

-- CreateTable
CREATE TABLE "booking_events" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "actorId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- Either both ends of a transition or neither. A `toState` with no `fromState` is
-- the creation event and is legitimate; a `fromState` with no `toState` describes
-- a move that went nowhere, which no writer means to record.
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_event_transition_is_complete"
  CHECK ("fromState" IS NULL OR "toState" IS NOT NULL);

-- CreateIndex
CREATE INDEX "booking_events_bookingId_createdAt_id_idx"
  ON "booking_events"("bookingId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "bookings_state_requestExpiresAt_idx"
  ON "bookings"("state", "requestExpiresAt");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "quotes"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_categoryVersionId_fkey"
  FOREIGN KEY ("categoryVersionId") REFERENCES "category_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- `RESTRICT` rather than Prisma's default for an optional relation, which is
-- `SET NULL` — and that would quietly rewrite history to say the *platform* did
-- something a person did.
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The erasure inversion, on the renter's end only.
--
-- **`quotes.listingId` deliberately stays CASCADE**, and changing it by symmetry
-- was a mistake this migration made and slice 4.4b's own db test caught. A listing
-- is only ever deleted when nothing has booked it, so its quotes are all unbooked;
-- a booked quote is protected by `bookings.quoteId`'s RESTRICT instead. Making this
-- RESTRICT would have meant an owner could not erase their account once a stranger
-- had asked their listing for a price — a §10.1 failure caused by somebody else's
-- action.
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_renterId_fkey";
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_renterId_fkey"
  FOREIGN KEY ("renterId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- §6.2 calls the state history immutable. This is what makes that true of the
-- storage rather than only of the code that writes it — the same mechanism slice
-- 2.1 used on `category_versions`, and the same deliberate omission: DELETE is
-- still permitted, because retention is a scheduled act and not an application
-- one.
CREATE FUNCTION "refuse_booking_event_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'booking_events is append-only: a state history that can be edited is evidence of nothing';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "booking_events_are_immutable"
  BEFORE UPDATE ON "booking_events"
  FOR EACH ROW EXECUTE FUNCTION "refuse_booking_event_update"();
