-- Migration: listing_collection_location
--
-- Slice 2.5a. A listing says where it is collected from (BRD §8.3), and the
-- platform publishes only the coarse half of that (BRD §8.4.1).
--
-- Why the address is split across two tables
-- -----------------------------------------
-- Every address the platform holds separates into a half anybody may see — the
-- outward code and the post town — and a half almost nobody may. `addresses`
-- draws that line between *columns* in one table, and relies on each query
-- selecting the right ones. That works there because an address row is never
-- public content: it is only ever read through a deliberate projection.
--
-- A listing is the opposite. It exists to be shown to strangers, and 2.10 and
-- Phase 3 will both select it broadly. A full postcode on that row would be
-- personal data protected only by every future author remembering a `select`.
--
-- So the line is drawn between *tables*. `listings.outwardCode` and
-- `listings.town` have never held anything finer than a postal district
-- covering thousands of homes, and the precise half lives in a table the public
-- projection does not join at all. A `select` can be forgotten; a join that was
-- never written cannot.
--
-- It also makes erasure a row delete rather than a set of nullings, which
-- matters because this row must *survive* its owner's account deletion — a
-- listing is referenced by booking history from Phase 4 — while everything
-- precise about where somebody lives must not.
--
-- And it is where slice 2.5b puts the coordinates, the persisted fuzz offset
-- and the `geography(Point,4326)` column BRD §4.2 requires. That column is
-- `Unsupported` in Prisma and queryable only in raw SQL; on `listings` it would
-- put a raw-SQL-only concern on the central model of this entire phase.
--
-- Why the postcode is not encrypted and the street lines are
-- ---------------------------------------------------------
-- The same decision `addresses` records. Slice 2.5b geocodes `postcode`, and
-- encrypting a value the geocoder needs would mean decrypting every row to
-- answer "what is near me". It is protected by living in a table no public
-- query joins, not by a cipher. The street lines are encrypted because nothing
-- operational needs them queryable — they are read back to an owner, or
-- released to a renter once a booking authorises it (§8.4.1) — so a stolen dump
-- yields postal districts instead of front doors.
--
-- Why the CHECK, and why it cannot cover everything
-- ------------------------------------------------
-- `location_is_complete` refuses a listing that has an outward code and no town
-- or the reverse. Both-or-neither is the only coherent pair: a district with no
-- town is unreadable to a person judging whether something is near them, and a
-- town with no district is the coarse half of nothing.
--
-- What no constraint here can express is the *cross-table* rule — that a listing
-- with a `listing_locations` row also has these two columns set. Postgres would
-- need a trigger on both tables, and that trigger would be a second copy of a
-- rule the store already keeps by writing both in one transaction. Same
-- argument the transport requirement made about its vocabulary two migrations
-- ago: a database check that has to read another table's row is a diverging
-- duplicate, not a safety net.
--
-- Data impact
-- -----------
-- Two nullable columns on `listings`, and one new table.
--
-- In PostgreSQL 11 and later, ADD COLUMN with no DEFAULT is a catalogue-only
-- change — existing rows are not rewritten. Locally that is three draft
-- listings from 2.4a, 2.4b and 2.4c-ii; there is no deployed environment.
--
-- **Existing drafts are left saying nothing, truthfully.** No backfill invents a
-- collection address, and none could: nobody was ever asked. They read as "not
-- said yet", which is a legitimate state for a draft under §8.3 and is exactly
-- what they are.
--
-- `listings` takes a brief ACCESS EXCLUSIVE lock for the two columns. Only the
-- owner's own routes read it today.
--
-- ON DELETE CASCADE from `listings`, deliberately: a location with no listing is
-- an address belonging to nothing, and the row it describes is the only thing
-- that gives it meaning. It is the opposite of the RESTRICT on `listings.ownerId`
-- — that one exists so a listing cannot vanish from a booking's history, and
-- this one exists so an address cannot outlive the listing that justified
-- holding it.
--
-- Rollback
-- --------
--   DROP TABLE "listing_locations";
--   ALTER TABLE "listings" DROP CONSTRAINT "location_is_complete";
--   ALTER TABLE "listings" DROP COLUMN "outwardCode";
--   ALTER TABLE "listings" DROP COLUMN "town";
--
-- Lossless for any listing created before this migration, and lossy after it:
-- dropping them discards an address an owner typed, which no other table holds.
-- Roll forward once real listings exist.

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "outwardCode" TEXT,
ADD COLUMN     "town" TEXT;

-- CreateTable
CREATE TABLE "listing_locations" (
    "listingId" UUID NOT NULL,
    "postcode" TEXT NOT NULL,
    "encryptedDetail" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "listing_locations_pkey" PRIMARY KEY ("listingId")
);

-- AddForeignKey
ALTER TABLE "listing_locations" ADD CONSTRAINT "listing_locations_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The publishable pair is both-or-neither. Named rather than anonymous so a
-- violation says what rule was broken, the way `approver_is_not_proposer` and
-- `suspension_is_complete` do.
ALTER TABLE "listings" ADD CONSTRAINT "location_is_complete"
  CHECK (("outwardCode" IS NULL) = ("town" IS NULL));
