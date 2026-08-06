-- Migration: listing_coordinates_and_fuzz_offset
--
-- Slice 2.5b. A listing's postcode becomes a point, and the point the platform
-- publishes is deliberately the wrong one (BRD §8.4.1, §4.2, ADR 0032).
--
-- Why six columns and not two
-- ---------------------------
-- The true coordinate is kept because Phase 7 hands the renter an exact place
-- once a booking authorises collection, and re-geocoding at handover would make
-- two strangers meeting depend on a third party being up.
--
-- The offset is kept because §8.4.1 requires it to be *persisted* and never
-- recomputed — recomputing per request leaks the true point through averaging —
-- and because keeping it makes it possible to show a listing was displaced by at
-- least 500 m without recovering anything.
--
-- The fuzzed coordinate is kept rather than derived at read time for the reason
-- `addresses.outwardCode` is: deriving makes the published location the output
-- of a function somebody can change, and a different earth radius or a rounding
-- difference would silently move every listing on the platform. Storing makes it
-- a fact rather than a calculation.
--
-- ADR 0032 records why the offset is drawn at random and stored rather than
-- derived from the listing id with a keyed function. In short: a derived offset
-- is invertible, so a leaked key yields every owner's home address with no
-- database access at all, and silently.
--
-- Why the geography column is on the fuzzed point
-- ----------------------------------------------
-- BRD §4.2 requires a **nullable** `Unsupported("geography(Point,4326)")`
-- maintained by trigger or generated column, with a GiST index, because Prisma
-- has no geography support and a *required* Unsupported column blocks ordinary
-- Prisma Client writes on the model.
--
-- It is derived from `fuzzedLatitude`/`fuzzedLongitude`, not the true pair,
-- because it exists to serve Phase 3's public radius query and §8.4.1 lets that
-- query touch nothing else. An index on the true point would be an index no
-- public query may use — and worse, a tempting one: filtering on the true
-- coordinate while displaying a fuzzed distance lets an attacker binary-search
-- the radius from three origins and recover the exact point. That is the
-- trilateration attack §8.4.1 opens by describing, arriving through the filter
-- rather than through the displayed number. ADR 0032 makes this binding.
--
-- A trigger rather than a GENERATED column: a generated column must be
-- IMMUTABLE, and the geography cast chain is not marked so in PostGIS 3.5.
--
-- Why the CHECK, and what it cannot cover
-- --------------------------------------
-- `location_is_geocoded_or_not` refuses a half-geocoded row: all six columns
-- null, or all six set. Every partial state is a bug — a true point with no
-- offset would be a listing whose exact position is the published one, which is
-- the failure §8.4.1 exists to prevent, and it would be silent.
--
-- What it cannot express is that the fuzzed point is *actually* at least 500 m
-- from the true one. That needs trigonometry over two column pairs, which
-- Postgres could do and which would be a second, diverging copy of `fuzz.ts`.
-- The application owns that rule and a unit test asserts it over 500 samples.
--
-- Data impact
-- -----------
-- Six nullable columns, one Unsupported column, one trigger, one GiST index.
-- ADD COLUMN with no DEFAULT is catalogue-only in PostgreSQL 11+, so existing
-- rows are not rewritten.
--
-- **Existing rows are left ungeocoded, truthfully.** Locally that is the single
-- listing 2.5a created; there is no deployed environment. No backfill invents a
-- coordinate, and none could without calling a third party from inside a
-- migration — which would make a schema change depend on somebody else's uptime.
-- They read as "not located yet", which is exactly what they are, and saving one
-- again geocodes it.
--
-- The trigger fires only on INSERT and on an UPDATE that touches the fuzzed
-- pair, so it costs nothing on the writes that do not.
--
-- Rollback
-- --------
--   DROP TRIGGER listing_locations_set_fuzzed_point ON "listing_locations";
--   DROP FUNCTION listing_locations_fuzzed_point();
--   DROP INDEX "listing_locations_fuzzedPoint_idx";
--   ALTER TABLE "listing_locations" DROP CONSTRAINT "location_is_geocoded_or_not";
--   ALTER TABLE "listing_locations"
--     DROP COLUMN "latitude", DROP COLUMN "longitude",
--     DROP COLUMN "fuzzBearingDegrees", DROP COLUMN "fuzzDistanceMetres",
--     DROP COLUMN "fuzzedLatitude", DROP COLUMN "fuzzedLongitude",
--     DROP COLUMN "fuzzedPoint";
--
-- Lossless for rows written before this migration. **Lossy afterwards, and in a
-- way that cannot be undone: dropping the offset columns discards a value that
-- was drawn at random and exists nowhere else.** Re-geocoding recovers the true
-- point; nothing recovers the original displacement, so every listing would move
-- and anybody holding both published points learns the true one is within a
-- kilometre of each. Roll forward once real listings exist.
--
-- PostGIS is already installed — `infra/postgres` enables it and `pnpm db:verify`
-- asserts it — so this migration does not create the extension.

-- AlterTable
ALTER TABLE "listing_locations"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "fuzzBearingDegrees" INTEGER,
  ADD COLUMN "fuzzDistanceMetres" INTEGER,
  ADD COLUMN "fuzzedLatitude" DOUBLE PRECISION,
  ADD COLUMN "fuzzedLongitude" DOUBLE PRECISION,
  ADD COLUMN "fuzzedPoint" geography(Point,4326);

-- All six, or none. Named so a violation says which rule was broken, the way
-- `approver_is_not_proposer` and `suspension_is_complete` do.
ALTER TABLE "listing_locations" ADD CONSTRAINT "location_is_geocoded_or_not" CHECK (
  (
    "latitude" IS NULL AND "longitude" IS NULL
    AND "fuzzBearingDegrees" IS NULL AND "fuzzDistanceMetres" IS NULL
    AND "fuzzedLatitude" IS NULL AND "fuzzedLongitude" IS NULL
  ) OR (
    "latitude" IS NOT NULL AND "longitude" IS NOT NULL
    AND "fuzzBearingDegrees" IS NOT NULL AND "fuzzDistanceMetres" IS NOT NULL
    AND "fuzzedLatitude" IS NOT NULL AND "fuzzedLongitude" IS NOT NULL
  )
);

-- The bearing is a compass direction and the distance is BRD §8.4.1's floor.
-- Cheap to state in the database, and the floor is normative — a future edit to
-- `fuzz.ts` that lowered it would fail here rather than quietly publishing
-- points too close to their owners' front doors.
ALTER TABLE "listing_locations" ADD CONSTRAINT "fuzz_offset_is_within_bounds" CHECK (
  ("fuzzBearingDegrees" IS NULL OR ("fuzzBearingDegrees" >= 0 AND "fuzzBearingDegrees" < 360))
  AND ("fuzzDistanceMetres" IS NULL OR "fuzzDistanceMetres" >= 500)
);

-- The geography, maintained from the fuzzed pair and never written by
-- application code. `ST_MakePoint` takes (longitude, latitude) — x then y —
-- which is the reverse of how the pair is spoken and written everywhere else,
-- and is the single easiest thing to get wrong in this file. There is a db test
-- that puts a listing in Bristol and asserts PostGIS agrees.
CREATE OR REPLACE FUNCTION listing_locations_fuzzed_point() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."fuzzedLatitude" IS NULL OR NEW."fuzzedLongitude" IS NULL THEN
    NEW."fuzzedPoint" := NULL;
  ELSE
    NEW."fuzzedPoint" := ST_SetSRID(
      ST_MakePoint(NEW."fuzzedLongitude", NEW."fuzzedLatitude"), 4326
    )::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER listing_locations_set_fuzzed_point
  BEFORE INSERT OR UPDATE OF "fuzzedLatitude", "fuzzedLongitude"
  ON "listing_locations"
  FOR EACH ROW
  EXECUTE FUNCTION listing_locations_fuzzed_point();

-- GiST, as BRD §4.2 requires. Nothing queries it until Phase 3; it is created
-- now because the column is, and an index added later against a populated table
-- is a lock nobody wants.
CREATE INDEX "listing_locations_fuzzedPoint_idx"
  ON "listing_locations" USING GIST ("fuzzedPoint");
