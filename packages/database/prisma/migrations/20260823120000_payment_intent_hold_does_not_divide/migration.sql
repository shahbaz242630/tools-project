-- Migration: payment_intent_hold_does_not_divide
--
-- Slice 5.5c-i. `payment_intents` can hold an amount that does not divide —
-- BRD §8.7.2's damage-security hold, which reserves the applied excess against
-- the renter's card and takes nothing.
--
-- Why the columns are relaxed
-- ---------------------------
-- A hire charge splits between an owner and us, so `itemChargeMinor` and
-- `renterFeeMinor` are what it is made of. **A hold splits nothing**, because
-- nothing has moved: it is a reservation and an expiry. No owner is owed
-- proceeds and no platform fee is earned while it stands, so there is no
-- division to record and a zero would be a claim rather than an absence — a zero
-- item charge is a real thing (an item lent free), and it is not this.
--
-- The `payment_intents` migration that created these columns said this relaxation
-- would come and called it "a reviewed migration, which is the right cost for a
-- table holding money". This is that migration.
--
-- Why one CHECK keyed on `purpose`, not three made null-tolerant
-- --------------------------------------------------------------
-- This is the part to read before changing it. The three constraints being
-- dropped each assumed a division:
--
--   intent_item_charge_is_positive     "itemChargeMinor" > 0
--   intent_renter_fee_is_not_negative  "renterFeeMinor" >= 0
--   intent_total_is_its_parts          "itemChargeMinor" + "renterFeeMinor" = "amountMinor"
--
-- The obvious relaxation is to make each tolerate NULL. **That would also stop
-- requiring a hire charge to divide**, because a NULL comparison is not false —
-- so a charge written with no parts, or with parts that do not sum to its total,
-- would become storable. The rule we want is not weaker, it is *conditional*:
-- exactly one shape per purpose. So the three become one constraint that names
-- the purpose it is talking about.
--
-- **Every column's nullness is stated explicitly in every branch**, which is the
-- lesson slice 5.5b-ii learned by firing it: `NULL IN (...)` evaluates to NULL,
-- `true AND NULL` is NULL, and **a CHECK passes on NULL** — it only fails on
-- false. A branch that leaves a column's nullness implied is a branch that lets
-- the wrong row through.
--
-- **The hold branch names `damage_security` rather than saying "not a charge".**
-- A third purpose therefore fails this CHECK until somebody amends it, which is
-- deliberate and fail-closed: `<> 'hire_charge'` would silently decide that every
-- future purpose divides nothing, and that decision belongs to whoever adds the
-- flow — the same rule that keeps a vocabulary arriving with the flow that writes
-- it. Adding a purpose to a table holding money should cost a migration.
--
-- Data impact
-- -----------
-- **None.** Every existing row is a `hire_charge` written under the old
-- constraints, so all of them satisfy the charge branch of the new one by
-- construction — the new branch is the conjunction of the three it replaces plus
-- two IS NOT NULLs that were `NOT NULL` column definitions until this migration.
-- Postgres validates the constraint against existing rows as it adds it, so a row
-- that did not satisfy it would fail this migration loudly rather than pass
-- silently. Nothing is rewritten, and the local and staging databases hold no
-- `payment_intents` rows at all today.
--
-- Rollback
-- --------
-- Roll forward. To reverse: drop `intent_divides_only_if_it_is_a_charge`,
-- re-add the three original CHECKs, and set both columns `NOT NULL` again — the
-- last step fails if any `damage_security` row has been written by then, which is
-- correct, because those rows have no division to restore. Delete them first if
-- the reversal is genuinely wanted.

ALTER TABLE "payment_intents" ALTER COLUMN "itemChargeMinor" DROP NOT NULL;
ALTER TABLE "payment_intents" ALTER COLUMN "renterFeeMinor" DROP NOT NULL;

ALTER TABLE "payment_intents" DROP CONSTRAINT "intent_item_charge_is_positive";
ALTER TABLE "payment_intents" DROP CONSTRAINT "intent_renter_fee_is_not_negative";
ALTER TABLE "payment_intents" DROP CONSTRAINT "intent_total_is_its_parts";

ALTER TABLE "payment_intents" ADD CONSTRAINT "intent_divides_only_if_it_is_a_charge"
  CHECK (
    (
      "purpose" = 'hire_charge'
      AND "itemChargeMinor" IS NOT NULL
      AND "renterFeeMinor" IS NOT NULL
      AND "itemChargeMinor" > 0
      AND "renterFeeMinor" >= 0
      AND "itemChargeMinor" + "renterFeeMinor" = "amountMinor"
    )
    OR (
      "purpose" = 'damage_security'
      AND "itemChargeMinor" IS NULL
      AND "renterFeeMinor" IS NULL
    )
  );
