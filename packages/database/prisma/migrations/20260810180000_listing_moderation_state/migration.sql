-- Migration: listing_moderation_state
--
-- Slice 2.8c-i. What the platform permits, beside what the owner wants
-- (BRD §8.3, §9, §14 Phase 2; ADR 0041).
--
-- Why this is a column and not more values in `listings.status`
-- ------------------------------------------------------------
-- `status` answers *what the owner wants* — draft, published, paused — and
-- every value in it is written by the owner. Moderation answers *what the
-- platform permits*, is written by somebody else, and is not an expression of
-- the owner's intent at all.
--
-- They are independent in fact: a listing can be published and under review, or
-- paused and rejected. Folded into one field, a rejection would overwrite the
-- owner's intent and reinstatement would have to guess what to put back —
-- and guessing `PUBLISHED` would silently republish a listing whose owner had
-- paused it in the meantime. ADR 0041 records the alternatives.
--
-- Why there is no CHECK constraint on it
-- --------------------------------------
-- The convention slice 2.4a's migration set, and the reasoning is unchanged:
-- the vocabulary is a closed union in code with an adapter that throws on
-- anything else, exactly as `status`, `risk_level` and `reportable_activity`
-- are. `seller_tax_profiles` remains the documented exception, and it is an
-- exception because it has no adapter at all.
--
-- The pair of columns below *is* constrained, because that rule is about the
-- relationship between two columns rather than about a vocabulary, and nothing
-- in the application can see a row it did not write.
--
-- Data impact
-- -----------
-- Every existing listing becomes `APPROVED` with no reason, which is the state
-- they are all in today: nothing has ever been moderated, and `APPROVED` is the
-- default precisely because §8.3 makes moderation something that flags rather
-- than a gate every listing queues at.
--
-- **This is a backfill of a judgement nobody made**, which this project has
-- refused three times before — fee rates, transport options and attribute
-- schemas all defaulted to "nothing configured" rather than to a guess. It is
-- correct here and the difference is worth stating: `APPROVED` is not a
-- decision, it is the absence of one. There is no moderator, no queue and no
-- signal, so "nobody has objected to this listing" is literally true of every
-- row. The reason column stays NULL, so a listing approved by default is
-- distinguishable from one an administrator reinstated — the audit entry and
-- the reason are what record a real decision.
--
-- `DEFAULT` is kept on the column rather than dropped after the backfill. A
-- listing created by an older build during a rolling deploy must land in a
-- legal state, and the default is what guarantees that. It is also what makes
-- this migration expand-only.
--
-- The table is rewritten to add a NOT NULL column with a default. On Postgres 11+
-- that is a metadata-only change — no table rewrite — so the ACCESS EXCLUSIVE
-- lock is held briefly regardless of row count. `listings` has eight rows.
--
-- Rollback
-- --------
-- `ALTER TABLE listings DROP COLUMN "moderationState", DROP COLUMN "moderationReason", DROP COLUMN "moderatedById", DROP COLUMN "moderatedAt";`
--
-- Safe, and lossy in one specific way worth stating: any listing an
-- administrator had hidden becomes visible again the moment the column goes,
-- because `isPubliclyVisible` falls back to reading the status alone. **A
-- rollback after a real moderation decision therefore un-hides that listing.**
-- The audit trail records every decision, so they can be re-applied — but
-- whoever rolls back needs to know that the window is not neutral. Nothing here
-- is referenced by another table, so the drop itself cannot fail.

ALTER TABLE "listings"
    -- What the platform permits. Text with the vocabulary in code, as above.
    ADD COLUMN "moderationState" TEXT NOT NULL DEFAULT 'APPROVED',

    -- Why, in the administrator's own words.
    --
    -- Nullable, because `APPROVED` needs no reason: it is the default state and
    -- reinstating somebody is not a decision that needs defending to them. The
    -- CHECK below is what stops it being null for the states that do.
    ADD COLUMN "moderationReason" TEXT,

    -- Who decided, and when.
    --
    -- Both nullable together, and null for every row that has never been
    -- moderated — which is the whole table today. That is the same distinction
    -- `moderationReason` draws: a listing at the default is not one somebody
    -- approved.
    --
    -- `ON DELETE RESTRICT` by omission, Prisma's default for an optional
    -- relation being SET NULL — stated here because the choice matters. An
    -- administrator's account being deleted must not quietly erase who took a
    -- decision, and accounts are soft-deleted anyway (the `users` row survives
    -- with its personal data removed), so this reference always resolves.
    ADD COLUMN "moderatedById" UUID,
    ADD COLUMN "moderatedAt" TIMESTAMPTZ(3);

-- A hidden listing must say why.
--
-- The rule is about the relationship between two columns rather than about a
-- vocabulary, which is why it is here and the state itself is not. §9 requires
-- administrative actions to carry a reason and ADR 0024 established that the
-- subject reads it; a listing taken down with an empty explanation is what makes
-- somebody conclude the platform is arbitrary.
--
-- Written as "not APPROVED implies a non-blank reason" rather than naming the
-- two hiding states, so a fourth state added later inherits the requirement
-- instead of slipping past a list nobody remembered to extend.
ALTER TABLE "listings"
    ADD CONSTRAINT "moderation_hidden_has_a_reason"
    CHECK (
        "moderationState" = 'APPROVED'
        OR ("moderationReason" IS NOT NULL AND btrim("moderationReason") <> '')
    );

-- Who and when travel together.
--
-- One without the other is a decision with no author or an author with no
-- decision, and both are the kind of half-written row that is only ever noticed
-- years later by somebody trying to answer "who took this listing down".
ALTER TABLE "listings"
    ADD CONSTRAINT "moderation_authorship_is_complete"
    CHECK (
        ("moderatedById" IS NULL AND "moderatedAt" IS NULL)
        OR ("moderatedById" IS NOT NULL AND "moderatedAt" IS NOT NULL)
    );

ALTER TABLE "listings"
    ADD CONSTRAINT "listings_moderatedById_fkey"
    FOREIGN KEY ("moderatedById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The query Phase 3 runs most: what may the public see.
--
-- Partial, on the visible combination only, because that is the one search asks
-- for and an index covering hidden listings would be mostly dead weight — the
-- overwhelming majority of rows are `PUBLISHED`/`APPROVED` or not published at
-- all. Named for the question rather than the columns.
CREATE INDEX "listings_publicly_visible_idx"
    ON "listings" ("createdAt" DESC)
    WHERE "status" = 'PUBLISHED' AND "moderationState" = 'APPROVED';
