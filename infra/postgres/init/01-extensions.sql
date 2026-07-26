-- Runs once on first container start, against POSTGRES_DB.
--
-- Extensions are created here rather than in a Prisma migration because
-- CREATE EXTENSION needs superuser rights that the application role should
-- not hold in production. Production provisioning must run the equivalent.

-- Radius search, coordinates and distance filters (BRD §4.2, §8.4).
CREATE EXTENSION IF NOT EXISTS postgis;

-- Required for the booking overlap EXCLUDE constraint (BRD §8.5.1). Without
-- btree_gist a range-overlap exclusion cannot also match on listing_id, and
-- double-booking prevention would fall back to a racy application check.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Trigram search for listing titles. Cheap, and avoids standing up a separate
-- search service for the pilot.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive text, used for email and postcode comparison.
CREATE EXTENSION IF NOT EXISTS citext;

-- Separate database for the integration test suite so tests can truncate
-- freely without destroying development data.
CREATE DATABASE rental_test TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';

\connect rental_test

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
