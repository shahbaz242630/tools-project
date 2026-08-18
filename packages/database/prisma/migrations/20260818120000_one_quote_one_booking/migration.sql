-- Migration: one_quote_one_booking
--
-- Slice 4.7a. One quote may become at most one booking, enforced by the database.
--
-- The hole this closes
-- --------------------
-- `bookings.quoteId` has carried a foreign key since 4.5a and no uniqueness, so a
-- double-press, two tabs, or a retried request turned **one** quote into two
-- identical `REQUESTED` bookings — same listing, same renter, same dates, same
-- price, two rows.
--
-- **§8.5.1's `EXCLUDE` constraint does not catch this, by design.** Its `WHERE`
-- covers the nine calendar-occupying states and §7.1 deliberately leaves
-- `REQUESTED` out of them, because several renters must be able to ask for the
-- same dates. So two `REQUESTED` duplicates are invisible to the one guarantee
-- this table has, and stay invisible right up to the moment an owner is shown the
-- same request twice and accepts one of them.
--
-- 4.5b already disables its submit button, which is the right thing to do and is
-- not a guarantee: it is one browser's opinion, lost on a reload, a second tab, or
-- a client that never runs the script.
--
-- Why a plain UNIQUE rather than a partial one
-- --------------------------------------------
-- The narrower reading would scope uniqueness to live states, so a quote whose
-- booking was declined or expired could be re-used. That is rejected because it is
-- re-pricing by another name, and this schema already refuses that idea in as many
-- words: `quotes` has **no `updatedAt`**, and the comment there says *"nothing
-- updates a quote. Re-pricing is a new quote, and a column suggesting otherwise
-- would be an invitation."* A quote is a one-shot artefact with a short expiry;
-- asking for a fresh price is free.
--
-- Plain UNIQUE is also the reading that can be widened later without repricing
-- anything retroactively, which is the direction this project takes its bounds in
-- (§8.5.2's weekend rate, ADR 0047).
--
-- **This does not make requesting idempotent**, and nothing here claims it does. A
-- renter with two *separate* quotes for the same dates still produces two bookings
-- — that is a different rule, per-renter-per-listing-per-period, and it is recorded
-- as an open gap rather than smuggled in here.
--
-- Data impact
-- -----------
-- **A UNIQUE index on an existing column, which fails loudly if the data already
-- violates it** — so the guard below runs first and says *what* collides rather
-- than leaving a bare index-creation error. Checked against the local fixture
-- before writing this: 6 bookings, 6 distinct quotes.
--
-- Building the index takes a brief lock on `bookings`. The table is small and the
-- platform is pre-launch; `CONCURRENTLY` is deliberately not used because it
-- cannot run inside the transaction Prisma wraps a migration in.
--
-- If this migration fails on duplicates, the fix is a decision and not a script:
-- somebody has to say which of the two bookings is real. That is why it raises
-- rather than de-duplicating on its own.
--
-- Rollback
-- --------
--   DROP INDEX "bookings_quoteId_key";
--
-- Safe in both directions and at any time: dropping it removes a guarantee and
-- destroys no data. Nothing reads the index by name.

DO $$
DECLARE
    duplicate_count INTEGER;
    example TEXT;
BEGIN
    SELECT count(*) INTO duplicate_count
    FROM (
        SELECT "quoteId" FROM "bookings" GROUP BY "quoteId" HAVING count(*) > 1
    ) AS duplicates;

    IF duplicate_count > 0 THEN
        SELECT string_agg(format('%s (%s bookings)', "quoteId", n), ', ')
        INTO example
        FROM (
            SELECT "quoteId", count(*) AS n
            FROM "bookings"
            GROUP BY "quoteId"
            HAVING count(*) > 1
            ORDER BY count(*) DESC
            LIMIT 5
        ) AS worst;

        RAISE EXCEPTION
            'cannot make bookings.quoteId unique: % quote(s) already have more than one booking (%). '
            'Decide which booking is real before applying this migration -- this is not something a '
            'migration may choose.',
            duplicate_count, example;
    END IF;
END $$;

-- Named the way Prisma names a field-level `@unique`, so `schema.prisma` and the
-- database agree and `prisma migrate diff` stays quiet. Getting this name wrong is
-- how a migration introduces the very drift 4.7a just finished closing on
-- `listings.moderatedById`.
CREATE UNIQUE INDEX "bookings_quoteId_key" ON "bookings"("quoteId");
