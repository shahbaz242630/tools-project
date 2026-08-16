-- Migration: availability_blocks
--
-- Slice 4.3a. BRD §8.5: "Owner calendar supports available, unavailable and
-- booked periods." Booked is `bookings`; this is unavailable; **available is
-- the absence of both** and is computed rather than stored.
--
-- Three concepts, two tables
-- --------------------------
-- The alternative was one table with a `kind` column, and it was rejected
-- because it would put an owner's holiday and a renter's money in the same
-- rows. Every query about either would then begin by remembering which it
-- wanted, the overlap constraint would have to be scoped around it, and §10.1's
-- retention rules — which apply to one and not the other — would have no row to
-- attach to.
--
-- Why there is no EXCLUDE constraint here
-- ---------------------------------------
-- Two overlapping blocks are harmless. An owner who blocks a fortnight and then
-- blocks a week inside it has said the same thing twice; refusing the second
-- would be a form error about nothing. What must not overlap is two *bookings*,
-- and that constraint stays on `bookings` where it is.
--
-- **A block does not stop a booking at the database level, and that is stated
-- rather than hidden.** An `EXCLUDE` cannot span two tables, so nothing here
-- makes a booking over a blocked period impossible. What prevents it is the
-- availability check the request and acceptance paths run (slices 4.5 and 4.6),
-- and that check is a read followed by a write — racy in principle.
--
-- The race is worth naming precisely, because it is much smaller than the
-- double-booking one §8.5.1 forbids solving this way. Two *renters* racing for
-- the same dates is two strangers and real money, which is why that one is a
-- database constraint. An owner blocking dates at the same instant somebody
-- requests them is one person's left hand and right hand: the request is not a
-- reservation (§7.1), the owner sees it and declines, and nothing has been
-- taken. If that ever stops being true — an auto-accept, say — this needs
-- revisiting rather than patching.
--
-- ON DELETE CASCADE, unlike bookings
-- ----------------------------------
-- The opposite choice from `bookings.listingId`, and the difference is whose
-- row it is. A booking is a record of a transaction between two people and
-- outlives the listing (§10.1, and slice 4.2's erasure change). A block is the
-- owner's own note about their own item, so when the listing goes it goes —
-- there is nobody else whose record it is.
--
-- Data impact
-- -----------
-- One new table, one function, one trigger, one CHECK, two indexes. No existing
-- row is read or written.
--
-- Rollback
-- --------
--   DROP TABLE "availability_blocks";
--   DROP FUNCTION availability_blocks_period();
--
-- Lossless in the sense that matters: a dropped block makes a listing *more*
-- available, so nothing is double-sold by reversing this. It does lose what an
-- owner told us about their own diary, which they would have to re-enter.

-- CreateTable
CREATE TABLE "availability_blocks" (
  "id"        UUID NOT NULL,
  "listingId" UUID NOT NULL,
  "startAt"   TIMESTAMPTZ(3) NOT NULL,
  "endAt"     TIMESTAMPTZ(3) NOT NULL,
  "period"    tstzrange,
  "reason"    TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "availability_blocks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same pair `bookings` carries, for the same two reasons: an inverted range
-- raises rather than storing, and an empty one would sit in the table
-- overlapping nothing while looking like it blocked something.
ALTER TABLE "availability_blocks" ADD CONSTRAINT "block_ends_after_it_starts"
  CHECK ("endAt" > "startAt");

CREATE OR REPLACE FUNCTION availability_blocks_period() RETURNS TRIGGER AS $$
BEGIN
  NEW."period" := tstzrange(NEW."startAt", NEW."endAt", '[)');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER availability_blocks_set_period
  BEFORE INSERT OR UPDATE OF "startAt", "endAt"
  ON "availability_blocks"
  FOR EACH ROW
  EXECUTE FUNCTION availability_blocks_period();

ALTER TABLE "availability_blocks" ADD CONSTRAINT "block_period_is_present"
  CHECK ("period" IS NOT NULL);

-- The calendar reads one listing's blocks in date order.
CREATE INDEX "availability_blocks_listingId_startAt_idx"
  ON "availability_blocks" ("listingId", "startAt");

-- Overlap questions — "is anything blocking this period" — are range queries,
-- and this is what makes them one index probe rather than a scan of an owner's
-- whole diary.
CREATE INDEX "availability_blocks_period_idx"
  ON "availability_blocks" USING GIST ("period");
