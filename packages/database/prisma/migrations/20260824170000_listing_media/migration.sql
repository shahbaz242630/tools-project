-- Migration: listing_media
--
-- Slice 2.6b-i. BRD §6.2's **Listing media** — *"Storage key, order, moderation
-- status, hash, metadata"*. One row per photograph of a listed item. The bytes
-- live in Cloudflare R2 (ADR 0037); only their addresses live here.
--
-- Why two storage keys and not one
-- --------------------------------
-- `prepareImage` (slice 2.6a) produces two renditions from every upload: 1600 px
-- for a listing page and 400 px for a search card. Serving the large one to a
-- card spends a renter's mobile data to draw a thumbnail. Two columns rather
-- than one prefix plus a naming convention, because a convention is a rule that
-- lives in whichever file last remembered it.
--
-- Why there is no unique constraint on (listing_id, position)
-- ----------------------------------------------------------
-- Nothing else in this schema models an ordered collection, so this table sets
-- the precedent rather than inheriting one. `category_versions.attributes` is
-- JSON specifically to avoid needing a position column at all, which is a hint
-- about how much trouble the obvious answer is.
--
-- A unique constraint cannot express a reorder. Swapping two photographs needs
-- an intermediate state where two rows briefly share a position, which requires
-- DEFERRABLE INITIALLY DEFERRED — and **Prisma cannot express DEFERRABLE**, the
-- same wall the ledger hit with NULLS NOT DISTINCT. That migration's answer was
-- to change the data model rather than add SQL Prisma cannot see, because a
-- constraint the datamodel does not know about is one `migrate dev` writes a
-- migration to drop.
--
-- So duplicate positions are representable, and three things make that
-- harmless: reads order by (position, created_at, id), which is a total order
-- whatever the data says; a reorder rewrites every row of the listing in one
-- transaction rather than editing one; and the count cap keeps the set small
-- enough that a rewrite is trivial. A duplicate is a display-order question with
-- a deterministic answer, never a crash and never an unreachable row.
--
-- Why there is no unique constraint on sha256
-- ------------------------------------------
-- The hash deduplicates — the encode is deterministic, so the same photograph
-- twice yields the same digest. It is deliberately not enforced: two owners may
-- legitimately photograph the same mass-produced drill against the same white
-- wall, and a unique index would refuse the second one a photograph.
--
-- Why there is no CHECK on moderation_state
-- -----------------------------------------
-- The convention slice 2.4a set and slice 2.8c-i restated: a closed vocabulary
-- in code with an adapter that throws on anything else gets no CHECK. CHECKs
-- here are reserved for cross-column relationships and for vocabularies that can
-- never grow. `seller_tax_profiles` remains the documented exception, and it is
-- an exception because it has no adapter at all.
--
-- Why this table is mutable, unlike booking_events or ledger_entries
-- -----------------------------------------------------------------
-- Those three are evidence — a state history, the books, versioned
-- configuration — and an immutability trigger is what makes them evidence of
-- anything. An owner reordering, replacing and deleting their own photographs is
-- the product. A BEFORE DELETE refusal here would also break account erasure
-- outright, because the cascade from `listings` would hit it.
--
-- What ON DELETE CASCADE does not do
-- ----------------------------------
-- It removes rows. It cannot remove the bytes in R2, because Postgres cannot
-- call `ObjectStore.delete` — so every application path that destroys a listing
-- deletes the objects first and the rows after. That order is deliberate: a
-- failed object delete leaves the row behind and a retry finishes the job, where
-- rows-first would leave bytes nothing holds a record of, in a bucket whose
-- allowance is 10 GB and which is deliberately never enumerated.
--
-- It also never fires for a listing §10.1 *collapses* rather than deletes —
-- one a booking references. A photograph of somebody's garden, driveway or front
-- door is the owner's personal data and not the renter's record of what they
-- hired, so `eraseOwnedBy` deletes this listing's media explicitly in both
-- branches. The schema cannot express that; the store does.
--
-- Data impact
-- -----------
-- **None.** One new table, nothing backfilled, no existing row read or written.
-- `listings` has eight rows locally and none deployed. ADD COLUMN does not
-- appear here at all, so no table is rewritten and no ACCESS EXCLUSIVE lock is
-- held beyond the moment CREATE TABLE takes one.
--
-- Nothing writes to it in this migration's own slice until the routes land in
-- the same PR, and nothing reads it publicly until 2.6b-ii.
--
-- Rollback
-- --------
--   DROP TABLE "listing_media";
--
-- **Safe while the bucket is empty, and not after.** Dropping the table loses
-- the only record of which objects exist in R2 — and `ObjectStore` has no `list`
-- by design, precisely so nothing ever treats the bucket as the source of truth.
-- Once owners have uploaded anything, this becomes roll-forward-only: correct a
-- defect with another migration, and delete the objects through the application
-- before dropping their addresses.

-- CreateTable
CREATE TABLE "listing_media" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "displayKey" TEXT NOT NULL,
    "thumbnailKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "thumbnailWidth" INTEGER NOT NULL,
    "thumbnailHeight" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "moderationState" TEXT NOT NULL DEFAULT 'APPROVED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The only query this table serves: one listing's photographs in the owner's
-- order. `createdAt` is in the index so the tiebreak that makes the order total
-- is answered by the index rather than by a sort.
CREATE INDEX "listing_media_listingId_position_createdAt_idx" ON "listing_media"("listingId", "position", "createdAt");

-- AddForeignKey
-- CASCADE, the same side as `availability_blocks` and the opposite side from
-- `bookings`. The difference is whose record it is: a photograph is the owner's
-- own picture of their own item, and nobody else's history refers to it.
ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
