-- Migration: payment_intents
--
-- Slice 5.2b. BRD §6.2's **Payment intent** — *"External payment operation:
-- provider reference, status, idempotency key, authorisation expiry
-- (`capture_before`)"*. One row per attempt at moving money through a provider.
--
-- **It is mutable, and the ledger beside it is not.** That difference is the
-- whole reason this table exists rather than the flow posting straight to the
-- books. The ledger records what *happened* and §8.7 makes it permanent; an
-- intent records what is *happening* at somebody else's system, and that changes
-- — a card payment under SCA starts as a challenge in a browser and becomes an
-- outcome minutes later, by webhook. Writing an intent into an immutable table
-- would mean either a row per status (a state machine spelled as history, with
-- no way to ask what is true now) or posting to the ledger before the money
-- moved. Neither is what §8.7 asks for.
--
-- **No provider identifier is a key here, and that is ADR 0051 consequence 2.**
-- `providerReference` is an ordinary nullable column beside `provider`, which
-- names who issued it. Together they *are* the mapping row ADR 0051 requires:
-- rows written under Stripe stay readable after a move, and a migration to
-- another provider is a data backfill rather than a rewrite. Nothing joins on
-- them and nothing looks a booking up by them.
--
-- **No card data, ever** (§8.7: *"Use marketplace payments; never store card
-- details"*). There is no column here that could hold one, and the port above
-- this table has no vocabulary for one either.
--
-- **The row carries what it takes to settle, and that is the decision that cost
-- something to find.** An attempt's outcome usually arrives *later and out of
-- band* — a 3-D Secure challenge finishes minutes after the request that started
-- it, and the confirmation is a webhook carrying a provider reference and
-- nothing else. Whatever handles that has no booking in hand, and Payments may
-- not read `bookings` (BRD §5.1). So the split this charge divides into —
-- `ownerId`, the pinned `categoryVersionId`, the item charge and the renter fee
-- — is **copied onto this row when the attempt opens**, the way §8.2 already has
-- a booking copy its terms from the quote rather than joining back to a listing.
-- Without it the ordinary SCA journey cannot be completed at all, which is how
-- this was found: a test of the common case, not of an edge.
--
-- Five decisions worth knowing before changing anything
-- -----------------------------------------------------
--
-- 1. **`attemptKey` is unique, and it is per *attempt* rather than per booking.**
--    It is what makes a double-pressed pay button one charge: the second press
--    presents the same key, finds the row, and no second provider call is made.
--    A renter whose card was declined is entitled to try again, and that retry
--    is a new attempt with a new key — reusing the first would return the first
--    failure forever. **The ledger's idempotency key is the per-booking one**;
--    the two are different things and conflating them is how a retry becomes
--    unpayable.
--
-- 2. **At most one *succeeded* intent per booking and purpose**, as a partial
--    unique index. §8.7.1 is blunt: *"Only one capture is possible per
--    authorisation"* and *"the amount held is a hard ceiling"*. Expressing it
--    here makes a double capture unrepresentable rather than merely refused by
--    whichever code path happened to check. It is scoped by `purpose` because a
--    hire charge and a damage-security hold are two operations on one booking,
--    not one operation twice — and it is partial because failed and abandoned
--    attempts must be allowed to accumulate, which is exactly what a retry is.
--
-- 3. **`status` has no CHECK, deliberately** — unlike `ledger_entries.direction`
--    which has one. That constraint was justified by the vocabulary never
--    growing; this one can and will. §8.7 already names *"failed payments,
--    expired authorisations, chargebacks and negative balances"*, so `expired`
--    and `charged_back` are values a later slice adds with the flow that
--    produces them. Text with the vocabulary in code, the same call
--    `bookings.state` makes.
--
-- 4. **`authorisationExpiresAt` is nullable and nothing writes it yet.** §8.7.2
--    is normative that the hold's expiry is *the provider's real timestamp*
--    (`capture_before`) and never a duration we assume, and §6.2 puts it on this
--    entity. A hire charge is captured outright and has no hold, so it stays
--    null until §8.7.2's damage-security flow arrives in Phase 7. The column is
--    here rather than added later because §6.2 names it as part of what this
--    entity *is*, and because a nullable timestamp costs nothing while a second
--    migration against a table holding money costs review.
--
-- 5. **The three settlement columns are `NOT NULL`, and §8.7.2's hold will have
--    to relax them.** A damage-security authorisation has an owner and a
--    category version but no item charge and no renter fee — it is not a hire
--    charge and does not divide. Making them nullable *now* would express a rule
--    nothing enforces; making them required expresses today's exactly, and the
--    day the second purpose arrives it comes with a reviewed migration. That is
--    the outcome we want for a table holding money, not one to be avoided.
--
-- `purpose` likewise carries one value today, `hire_charge`. The rule 5.1 set
-- for account kinds holds: a second value arrives **with the flow that writes
-- it**, not in anticipation of one.
--
-- Data impact
-- -----------
-- **None.** One new table, nothing backfilled, no existing row read or written.
-- Nothing writes to it yet either — 5.2b builds the service, and 5.2c is the
-- slice that gives it a caller.
--
-- Rollback
-- --------
--   DROP TABLE "payment_intents";
--
-- **Safe today and not after 5.2c.** Nothing writes here until a booking can be
-- paid for, so this table is empty and dropping it loses nothing. Once it holds
-- attempts it holds the only record of money we asked a provider to move, and
-- the rollback becomes roll-forward-only — correct a defect with another
-- migration.

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "categoryVersionId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT,
    "itemChargeMinor" INTEGER NOT NULL,
    "renterFeeMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "authorisationExpiresAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_attemptKey_key" ON "payment_intents"("attemptKey");

-- CreateIndex
CREATE INDEX "payment_intents_bookingId_idx" ON "payment_intents"("bookingId");

-- CreateIndex
CREATE INDEX "payment_intents_status_idx" ON "payment_intents"("status");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- `RESTRICT` for the reason `ledger_accounts.ownerId` gives: ADR 0015
-- soft-deletes accounts precisely so a financial record can never lose its
-- counterparty. A payee we cannot name is a payment we cannot make.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- The version whose fee policy divides this charge (§8.2). `category_versions`
-- is immutable, so the rate is provable years later — which is the whole reason
-- settlement reads the pinned version rather than the current one.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_categoryVersionId_fkey" FOREIGN KEY ("categoryVersionId") REFERENCES "category_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- The rules Prisma cannot express
-- --------------------------------------------------------------------------

-- §8.7.1: only one capture is possible per authorisation, and the held amount is
-- a hard ceiling. Two succeeded hire charges against one booking is a double
-- charge, and this is where it becomes impossible rather than merely unlikely.
-- Partial, so retries after a failure are unaffected — which is the whole point
-- of allowing a second attempt at all.
CREATE UNIQUE INDEX "one_succeeded_intent_per_booking_and_purpose"
  ON "payment_intents"("bookingId", "purpose")
  WHERE "status" = 'succeeded';

-- An empty key deduplicates nothing and would collide with the next empty one —
-- the same reason `ledger_transactions.idempotency_key_is_present` exists.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "attempt_key_is_present"
  CHECK (length(btrim("attemptKey")) > 0);

-- Strictly positive. Asking a provider to move nothing is never a thing we mean
-- to do, and a zero-amount attempt that "succeeds" would post a zero capture the
-- ledger refuses anyway (`entry_amount_is_positive`) — better to refuse it here,
-- where the error still names the booking.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "intent_amount_is_positive"
  CHECK ("amountMinor" > 0);

-- The charge must be its own parts. `settleHire` refuses a booking row that
-- disagrees with itself for the same reason, and this is the same rule one layer
-- down: money we cannot divide consistently is money that would put an error
-- into the ledger, where §8.7 makes it permanent.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "intent_total_is_its_parts"
  CHECK ("itemChargeMinor" + "renterFeeMinor" = "amountMinor");

-- The item's own charge is positive; the renter fee may legitimately be zero,
-- because fees are versioned configuration and a category may be run at cost.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "intent_item_charge_is_positive"
  CHECK ("itemChargeMinor" > 0);

ALTER TABLE "payment_intents"
  ADD CONSTRAINT "intent_renter_fee_is_not_negative"
  CHECK ("renterFeeMinor" >= 0);

-- A succeeded attempt must say which one it was at the provider, or the daily
-- reconciliation §8.7 requires has nothing to match against and a support
-- question has no answer. Deliberately not required before then: an attempt is
-- written *before* the provider is called, so that a crash between the two
-- leaves a record rather than an untraceable charge.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "succeeded_intent_has_a_provider_reference"
  CHECK ("status" <> 'succeeded' OR "providerReference" IS NOT NULL);

-- A failed attempt must say why, in our vocabulary. `failureMessage` is what a
-- payer is shown, so a failure with neither is a page that can only say
-- "something went wrong", which §8.7's *"clear failure and retry states"* rules
-- out.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "failed_intent_has_a_reason"
  CHECK ("status" <> 'failed' OR "failureReason" IS NOT NULL);
