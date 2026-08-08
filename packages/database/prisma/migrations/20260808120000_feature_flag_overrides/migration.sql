-- Migration: feature_flag_overrides
--
-- Slice H3a. Feature flags and emergency kill switches (BRD §5, §9, §12).
--
-- What this table is, and what it deliberately is not
-- --------------------------------------------------
-- It holds **overrides**, not flags. The set of flags is a closed vocabulary
-- declared in code (`feature-flags/catalogue.ts`), because a flag key gates a
-- code path and code paths are code — a key an administrator invented would
-- gate nothing, which is a dead control with a database row behind it.
--
-- A key with no row here is not "off". It is at whatever default its
-- declaration gives it, and that is the property that makes this safe: the
-- default lives where it can still be read when this table cannot be. A default
-- stored in the row you cannot read is not a default, and a database blip must
-- never silently flip behaviour.
--
-- It also means **adding a flag needs no migration** — it is a line in the
-- declaration, reviewed like any other code.
--
-- Why there is no version table beside it
-- --------------------------------------
-- Every other piece of configuration in this system is versioned, so the
-- absence is the decision worth recording (ADR 0036).
--
-- `category_versions` exists because §8.2 requires a booking to retain the
-- configuration version under which it was created — a booking *pins* a
-- version, and the row must therefore be immutable for as long as anything
-- points at it. **Nothing pins a flag.** A flag decides whether a code path
-- runs at the instant it runs, and no entity needs to remember its value
-- afterwards; there is no query anywhere in the system for "what was this flag
-- when that happened" that the audit trail does not already answer better.
--
-- Version rows would therefore add a table and an immutability trigger for no
-- invariant, and would make a kill switch slower to operate in exactly the
-- incident it exists for — §9 asks for "rapid disablement", and minting a
-- version to turn something off is the opposite.
--
-- Who changed it, when and why is §8.13's audit entry, which every write here
-- records. `changedById` and `updatedAt` are here as well because an
-- administrator reading the list needs them without leaving the page, and an
-- incident asks "when did this change" before it asks anything else.
--
-- Data impact
-- -----------
-- A new empty table. Nothing is backfilled and nothing could be: absence is
-- meaningful here and means "at its declared default", so inventing rows would
-- assert that somebody had chosen a value nobody chose. Every flag is at its
-- default the moment this lands, which is exactly the state the platform is in
-- today.
--
-- Rollback
-- --------
-- `DROP TABLE feature_flag_overrides;`. Nothing references it, and dropping it
-- returns every flag to its declared default — which is the same fail-safe path
-- the evaluator already takes when the table cannot be read. Any overrides in
-- force would be lost, so a rollback during an incident where something has
-- been switched *off* would switch it back on; the audit trail records what was
-- set, so it can be re-applied.

CREATE TABLE "feature_flag_overrides" (
    -- A synthetic identity, and it exists for exactly one reason:
    -- `audit_logs."targetId"` is a `uuid` column, so anything this system audits
    -- has to have one. `key` is a perfectly good natural key and would otherwise
    -- be the primary key; it is UNIQUE instead, which keeps the guarantee that
    -- matters — one flag has exactly one state — while giving the trail the
    -- shape it requires. `categories` is in the same position: an audit entry
    -- records its uuid rather than its slug.
    "id" UUID NOT NULL,

    -- The declared key, e.g. `listing.publication`.
    --
    -- Text with the vocabulary in code, exactly as `audit_logs.action` and
    -- `category_versions.risk_level` are: adding a flag is not a schema change.
    -- There is deliberately no CHECK pinning the keys, because unlike
    -- `seller_tax_profiles` — which has no code at all — this table always has
    -- code in front of it, and a key that code does not declare is ignored by
    -- the evaluator rather than trusted.
    "key" TEXT NOT NULL,

    "enabled" BOOLEAN NOT NULL,

    -- ON DELETE RESTRICT (the default): accounts are soft-deleted so it never
    -- fires, and an override that vanished with its author would leave the
    -- platform in a state nobody appeared to have chosen.
    "changedById" UUID NOT NULL,

    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- One row per flag. The guarantee the primary key would have given, kept here
-- so that two administrators switching the same flag at once cannot produce two
-- rows the evaluator would have to choose between.
CREATE UNIQUE INDEX "feature_flag_overrides_key_key" ON "feature_flag_overrides"("key");

ALTER TABLE "feature_flag_overrides"
    ADD CONSTRAINT "feature_flag_overrides_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
