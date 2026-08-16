-- Migration: listing_keyword_search
--
-- Slice 3.3a. A searcher can type words as well as a postcode (BRD §8.4, as
-- amended 16 August 2026 — the first amendment to that section that adds a
-- capability rather than moving one).
--
-- Why full-text search and not trigram
-- -----------------------------------
-- `pg_trgm` is already installed and is the better tool for *typos*, so it is
-- worth saying why it is not this. What a searcher types is words — "hedge
-- trimmer", "drill" — and words need stemming: `trimmers` must find `trimmer`
-- and `drilling` must find `drill`, which trigram similarity does not do and
-- full-text search does by construction. `websearch_to_tsquery` also gives
-- multi-word input the meaning a person expects (all the words, not any of
-- them) and, unlike `to_tsquery`, **never raises on malformed input** — so
-- somebody typing `&|!()` into the box gets a search rather than a 500.
--
-- Typo tolerance is a real later refinement and `pg_trgm` is how it will be
-- built. It wants a second index and a scoring decision, and it is not this
-- slice.
--
-- Why a trigger and not a generated column
-- ----------------------------------------
-- `GENERATED ALWAYS AS ... STORED` would be less code and the database would
-- maintain it with no function to keep in step. It is rejected on the same
-- ground `listing_locations.fuzzedPoint` rejected it, plus one more:
--
--   1. Postgres refuses any INSERT or UPDATE that names a generated column,
--      even to set it to its own value. Prisma excludes `Unsupported` columns
--      from the client API today, but that is a property of the client rather
--      than a guarantee in the schema, and the failure mode is every listing
--      write in the system erroring after a dependency bump.
--   2. `to_tsvector` is only immutable when the configuration is a literal
--      `regconfig`, which is a constraint a later editor would have to know
--      about and nothing states.
--
-- A trigger has neither problem, and — the actual reason — it makes this the
-- **same shape as the fuzzed point**, which is the other column in this schema
-- Prisma cannot hold. One pattern rather than two.
--
-- What is indexed, and what must never be
-- ---------------------------------------
-- `title` weighted A, `description` weighted B. The weights are unused today
-- because slice 3.3a ranks by distance and not by relevance — a deliberate
-- product decision, recorded in `searchKeywordSchema` — and they are set now
-- because they cost nothing and because backfilling them later means rewriting
-- every row.
--
-- **Nothing from `listing_locations` is in this document and nothing may be
-- added to it.** That table holds the encrypted street lines and the full
-- postcode; a text index over them would be the disclosure §8.4.1's two-table
-- split exists to make structurally impossible, and it would be invisible —
-- a `tsvector` is not readable as prose, so a leak through it would not look
-- like one in any response body.
--
-- `outwardCode` and `town` are excluded for a smaller reason: they are already
-- their own filter, and indexing them would let the word "Bristol" match every
-- listing in Bristol, quietly widening a search nobody widened.
--
-- Attribute values are excluded because they are JSON keyed by configuration,
-- and a stored `25` meaning 2.5 kg is not text anybody searches for.
--
-- Data impact
-- -----------
-- One nullable column, one function, one trigger, one GIN index.
--
-- ADD COLUMN with no DEFAULT is catalogue-only in PostgreSQL 11+, so existing
-- rows are not rewritten by the ALTER. **They are then backfilled**, which this
-- migration does explicitly rather than leaving to chance: unlike the fuzzed
-- point, which could not be backfilled without calling a geocoder from inside a
-- migration, every input here is already in the row. A listing left with a null
-- document would be a published listing that no keyword search can ever find,
-- silently, until somebody edited it.
--
-- The backfill is a single UPDATE over every listing. That is correct at this
-- size — two rows locally, none deployed — and it is worth knowing that it
-- would want batching at a size we do not have.
--
-- The trigger fires on INSERT and on an UPDATE that touches `title` or
-- `description`, so it costs nothing on the writes that do not — publication,
-- moderation, pausing and re-pinning all leave it alone.
--
-- Rollback
-- --------
--   DROP TRIGGER listings_set_search_document ON "listings";
--   DROP FUNCTION listings_search_document();
--   DROP INDEX "listings_searchDocument_idx";
--   ALTER TABLE "listings" DROP COLUMN "searchDocument";
--
-- **Losslessly, at any time.** Every input to this column is still in `title`
-- and `description`, so re-running the migration reconstructs it exactly. That
-- is the opposite of the fuzz-offset migration, whose rollback destroys a
-- random value stored nowhere else — worth the contrast, because it is what
-- makes this one safe to reverse after real data exists.

-- AlterTable
ALTER TABLE "listings" ADD COLUMN "searchDocument" tsvector;

-- `'english'` as a literal rather than a session setting: `to_tsvector(text)`
-- reads `default_text_search_config`, so a session with a different one would
-- write a document stemmed by different rules than the query that reads it —
-- and the symptom is not an error, it is a listing that stops being findable.
-- The literal makes the two sides agree by construction.
--
-- `coalesce` because `description` is legitimately empty on a draft (§8.3's
-- "save progress"), and `to_tsvector` of NULL is NULL — which would null the
-- whole document through the concatenation and make the title unfindable too.
CREATE OR REPLACE FUNCTION listings_search_document() RETURNS TRIGGER AS $$
BEGIN
  NEW."searchDocument" :=
    setweight(to_tsvector('english', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW."description", '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER listings_set_search_document
  BEFORE INSERT OR UPDATE OF "title", "description"
  ON "listings"
  FOR EACH ROW
  EXECUTE FUNCTION listings_search_document();

-- Backfill. See the data-impact note above: a listing with a null document is
-- one no search can find, and every input is already on the row.
UPDATE "listings"
SET "searchDocument" =
  setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("description", '')), 'B');

-- GIN rather than GiST, which is the standard choice for a `tsvector` that is
-- read far more often than written: GIN is slower to update and substantially
-- faster to search, and a listing is written once and searched by everybody.
CREATE INDEX "listings_searchDocument_idx"
  ON "listings" USING GIN ("searchDocument");
