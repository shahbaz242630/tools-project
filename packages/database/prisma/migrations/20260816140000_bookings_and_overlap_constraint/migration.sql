-- Migration: bookings_and_overlap_constraint
--
-- Slice 4.2. The entity BRD §7 describes, and §8.5.1's normative overlap
-- constraint — the one thing in Phase 4 that cannot be added later without
-- taking a lock on a populated table.
--
-- What §8.5.1 actually requires, and why nothing here is a choice
-- ---------------------------------------------------------------
-- "Overlap prevention must be enforced by the database, not by
-- application-level check-then-insert logic, which is racy under concurrency."
--
-- The mechanism is named: a PostgreSQL EXCLUDE constraint using btree_gist,
-- over listing_id WITH = and the booking period as a tstzrange WITH &&,
-- applied only to bookings in states that occupy the calendar. An alternative
-- may be substituted only with an ADR demonstrating equivalent guarantees
-- under concurrent load, evidenced by a test issuing simultaneous acceptances.
-- ADR 0004 is that decision and it chose the specified mechanism.
--
-- `btree_gist` is already installed — infra/postgres enables it and
-- `pnpm db:verify` has been proving the constraint is *creatable* against a
-- throwaway table since Phase 0. This is the first time a real one exists.
--
-- The nine blocking states
-- -----------------------
-- ACCEPTED, AWAITING_PAYMENT, PAYMENT_FAILED, RESERVED, READY_FOR_COLLECTION,
-- SECURITY_FAILED, COLLECTED, RETURN_DUE, LATE.
--
-- **REQUESTED is deliberately absent** and that is the whole design of §7.1:
-- several renters may hold a request against the same listing and the same
-- dates, none of them reserves anything, and the first *acceptance* to commit
-- wins. A REQUESTED booking that blocked the calendar would let the first
-- person to click decide who gets the item instead of the owner, and would let
-- anybody freeze a listing for free.
--
-- The list is duplicated between this file and
-- `apps/api/src/booking/booking-state-machine.ts`, which is unavoidable —
-- SQL cannot import TypeScript. A db test reads the constraint definition out
-- of `pg_constraint` and asserts it against `CALENDAR_OCCUPYING_STATES`, so
-- the two cannot drift silently.
--
-- Why the range is a separate column
-- ----------------------------------
-- Prisma cannot express `tstzrange` any more than it can `geography` or
-- `tsvector`, so this is the third instance of the pattern §4.2 established:
-- a nullable `Unsupported` column maintained by trigger, never written by
-- application code. `startAt` and `endAt` stay ordinary `timestamptz` columns
-- so the model remains fully writable through Prisma.
--
-- **This one needs a CHECK that the other two did not.** An EXCLUDE constraint
-- ignores NULL — two rows with a null range never conflict — so a booking
-- whose period failed to be set would escape the overlap guarantee silently,
-- which is the one failure this table exists to prevent. The trigger always
-- sets it from two NOT NULL columns, so a null is not reachable; the CHECK is
-- what makes it not *possible*. Named, like every other constraint here, so a
-- violation says which rule was broken.
--
-- `[)` rather than `[]`
-- ---------------------
-- Inclusive start, exclusive end. A hire ending at 09:00 on Tuesday and one
-- starting at 09:00 on Tuesday do not overlap, because the item changes hands.
-- With `[]` they would conflict and an owner could not let two people hire the
-- same tool on consecutive days, which is the ordinary case.
--
-- **No turnaround buffer.** Whether an owner needs an hour between hires is
-- category configuration and a product decision; widening the range here would
-- make it an invisible platform-wide rule nobody chose.
--
-- Data impact
-- -----------
-- One new table, one trigger, one function, one CHECK, one EXCLUDE constraint,
-- three indexes. **No existing row is read or written.**
--
-- The EXCLUDE constraint creates its own GiST index; the standalone index on
-- `period` is declared because Prisma's datamodel declares it, and without it
-- `migrate diff` reports drift and `migrate dev` would write a migration
-- dropping it.
--
-- Rollback
-- --------
--   DROP TABLE "bookings";
--   DROP FUNCTION bookings_period();
--
-- Lossless while the table is empty, which it is everywhere today. Once real
-- bookings exist this is roll-forward only: the table is the record of a
-- transaction between two members and §10.1 requires it to be retained.

-- CreateTable
CREATE TABLE "bookings" (
  "id"        UUID NOT NULL,
  "listingId" UUID NOT NULL,
  "renterId"  UUID NOT NULL,
  "state"     TEXT NOT NULL,
  "startAt"   TIMESTAMPTZ(3) NOT NULL,
  "endAt"     TIMESTAMPTZ(3) NOT NULL,
  "timeZone"  TEXT NOT NULL,
  "period"    tstzrange,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- RESTRICT on both, and on `listings` it is load-bearing rather than a default:
-- deleting a listing a booking points at would destroy the *renter's* record of
-- what they hired. `PrismaListingStore.deleteAllOwnedBy` is changed in this
-- slice to delete only unreferenced listings and collapse the rest.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_renterId_fkey"
  FOREIGN KEY ("renterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A hire that ends before it starts is not a period, and an empty one would sit
-- outside the overlap constraint without erroring — `tstzrange` of an inverted
-- pair raises, but of an equal pair returns `empty`, and `empty && anything` is
-- false. So this refuses both rather than letting a zero-length booking hold no
-- dates while looking like it holds some.
ALTER TABLE "bookings" ADD CONSTRAINT "booking_ends_after_it_starts"
  CHECK ("endAt" > "startAt");

-- The range, maintained from the two columns above and never written by
-- application code. Fires on INSERT and on an UPDATE that moves either bound,
-- so an edit cannot leave a booking holding the dates it used to have.
CREATE OR REPLACE FUNCTION bookings_period() RETURNS TRIGGER AS $$
BEGIN
  NEW."period" := tstzrange(NEW."startAt", NEW."endAt", '[)');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_set_period
  BEFORE INSERT OR UPDATE OF "startAt", "endAt"
  ON "bookings"
  FOR EACH ROW
  EXECUTE FUNCTION bookings_period();

-- See the header: an EXCLUDE constraint ignores NULL, so this is what stops a
-- booking with no range escaping the overlap guarantee. The trigger runs BEFORE
-- this is evaluated, so it can never fire through an ordinary write.
ALTER TABLE "bookings" ADD CONSTRAINT "booking_period_is_present"
  CHECK ("period" IS NOT NULL);

-- BRD §8.5.1, verbatim in mechanism. The WHERE is what makes REQUESTED
-- non-blocking per §7.1, and what keeps a cancelled or completed booking from
-- holding a listing's calendar forever.
ALTER TABLE "bookings" ADD CONSTRAINT "booking_periods_do_not_overlap"
  EXCLUDE USING gist ("listingId" WITH =, "period" WITH &&)
  WHERE ("state" IN (
    'ACCEPTED',
    'AWAITING_PAYMENT',
    'PAYMENT_FAILED',
    'RESERVED',
    'READY_FOR_COLLECTION',
    'SECURITY_FAILED',
    'COLLECTED',
    'RETURN_DUE',
    'LATE'
  ));

-- Both dashboards in slice 4.8 read one side's bookings, newest first.
CREATE INDEX "bookings_renterId_createdAt_idx" ON "bookings" ("renterId", "createdAt" DESC);
CREATE INDEX "bookings_listingId_createdAt_idx" ON "bookings" ("listingId", "createdAt" DESC);

-- Declared because the datamodel declares it. The EXCLUDE constraint has an
-- index of its own that Prisma cannot see, so without this `migrate diff`
-- reports drift on every run.
CREATE INDEX "bookings_period_idx" ON "bookings" USING GIST ("period");
