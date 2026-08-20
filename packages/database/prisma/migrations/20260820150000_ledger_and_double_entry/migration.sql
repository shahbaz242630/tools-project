-- Migration: ledger_and_double_entry
--
-- Slice 5.1, and the first slice of Phase 5. The platform's own books: BRD §8.7's
-- immutable double-entry ledger, with corrections as reversing entries.
--
-- **No provider anywhere in it, deliberately.** BRD §4: *"The platform database
-- must never treat a payment-provider webhook alone as the accounting record."*
-- If our ledger is the record and the provider is only the channel that executed
-- it, then changing provider is a change of adapter rather than a rewrite of the
-- books. That is the whole of the portability strategy the product owner asked
-- for on 20 August, and it is bought here rather than in any adapter.
--
-- Three tables, five CHECKs, five triggers.
--
-- 1. `ledger_accounts` — the chart of accounts
-- --------------------------------------------
-- `kind` is text with the vocabulary in code, exactly like `bookings.state`: a
-- chart of accounts gains rows as flows arrive, and a Postgres enum needs a
-- migration to gain one.
--
-- **`identity` is a single unique column rather than a composite unique on
-- (kind, ownerId, currency), and the reason is NULL.** Postgres treats NULLs as
-- distinct in a unique index, so the composite would permit *two*
-- `provider_clearing` accounts in GBP — the platform's balance silently split
-- across a pair of rows, which is exactly what a ledger exists to make
-- impossible. `NULLS NOT DISTINCT` would fix it and Prisma cannot express it,
-- which would leave the real guarantee in SQL the schema does not know about. A
-- derived natural key is expressible on both sides, and it also makes "the
-- account for this kind and this person, creating it if absent" a single
-- race-safe `upsert` — which the composite form cannot be in Prisma at all when
-- part of it is null.
--
-- 2. `ledger_transactions` — a balanced set of movements, posted as one act
-- ------------------------------------------------------------------------
-- `idempotencyKey` is unique, so §11.2's *"duplicate and out-of-order provider
-- webhooks produce exactly one ledger effect"* is the database's guarantee and
-- not a check-then-write that loses its own race.
--
-- `reversesId` is unique, so **a transaction can be reversed at most once**.
-- Without it a double-click posts two corrections, the original is undone twice,
-- and the net effect is having reversed something that never happened. Reversing
-- a *reversal* stays legal — it points at the correction, not at the original.
--
-- `occurredAt` and `recordedAt` are separate because reconciliation is daily
-- (§8.7) and the provider's clock decides which day a movement belongs to. One
-- timestamp puts a capture just before midnight on our side of the boundary and
-- their other side, and breaks reconciliation nightly for no reason anybody can
-- find.
--
-- 3. `ledger_entries` — one side of one movement
-- ----------------------------------------------
-- **Both foreign keys are composite on `(id, currency)`, and that is what the
-- two extra unique indexes are for.** CLAUDE.md requires minor units and an ISO
-- 4217 code *on the same record*, so an entry must carry its own currency — and
-- three copies of a currency can disagree. A composite foreign key makes an
-- entry whose currency differs from its transaction's or its account's
-- **unrepresentable** rather than merely wrong. A CHECK cannot span tables; a
-- foreign key can.
--
-- Every foreign key here is `ON DELETE RESTRICT`. ADR 0015 soft-deletes accounts
-- precisely so *"the ledger will reference these rows and can never lose a
-- counterparty"* — this is the reference that was being anticipated.
--
-- What the database refuses, and what it deliberately does not
-- ------------------------------------------------------------
-- `ledger_transactions` and `ledger_entries` refuse **UPDATE and DELETE**. That
-- is stricter than `booking_events`, which refuses UPDATE and permits DELETE so
-- retention stays a scheduled act rather than an application one, and the
-- difference is deliberate: §8.7 names *deleting* alongside editing. §10.1 keeps
-- financial records six years, and when that becomes due the trigger is dropped
-- in a reviewed migration — the deliberate act we want, recorded in version
-- control, rather than a capability left open for six years.
--
-- `ledger_accounts` refuses UPDATE only. An account has nothing legitimately
-- mutable, and one that has entries cannot be deleted anyway — the foreign keys
-- see to that.
--
-- **The balance rule is a DEFERRABLE constraint trigger**, because entries are
-- inserted after the transaction row they belong to and an immediate check would
-- fire against a transaction that has none yet. At COMMIT it asserts that each
-- touched transaction has at least two entries and that its debits equal its
-- credits. An unbalanced transaction is the one error that cannot be found
-- afterwards, because there is nothing left to compare it against.
--
-- **One thing it does not refuse, stated so nobody reads it as covered:**
-- inserting a further *balanced* pair of entries against an already-committed
-- transaction. The balance invariant still holds, so the ledger is never wrong;
-- the transaction is merely larger than it was. Nothing does this — entries are
-- only ever written with their transaction — and closing it would mean comparing
-- the parent row's inserting transaction id at insert time, which is exotic
-- enough to be its own bug.
--
-- Data impact
-- -----------
-- **None.** Three new tables, nothing backfilled, no existing row read or
-- written. Nothing posts to the ledger yet — 5.1 is the primitives, and the
-- flows that use them arrive with the slices that need them.
--
-- Rollback
-- --------
--   DROP TRIGGER "ledger_entry_keeps_its_transaction_balanced" ON "ledger_entries";
--   DROP TRIGGER "ledger_transaction_balances" ON "ledger_transactions";
--   DROP TRIGGER "ledger_entries_are_immutable" ON "ledger_entries";
--   DROP TRIGGER "ledger_transactions_are_immutable" ON "ledger_transactions";
--   DROP TRIGGER "ledger_accounts_are_immutable" ON "ledger_accounts";
--   DROP FUNCTION "assert_ledger_transaction_balances"();
--   DROP FUNCTION "refuse_ledger_write"();
--   DROP TABLE "ledger_entries";
--   DROP TABLE "ledger_transactions";
--   DROP TABLE "ledger_accounts";
--
-- Roll forward is preferred: nothing depends on these tables yet, so a defect
-- here is corrected by another migration rather than by unwinding this one.

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerId" UUID,
    "currency" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "bookingId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversesId" UUID,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_identity_key" ON "ledger_accounts"("identity");

-- CreateIndex
CREATE INDEX "ledger_accounts_ownerId_idx" ON "ledger_accounts"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_id_currency_key" ON "ledger_accounts"("id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotencyKey_key" ON "ledger_transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_reversesId_key" ON "ledger_transactions"("reversesId");

-- CreateIndex
CREATE INDEX "ledger_transactions_bookingId_idx" ON "ledger_transactions"("bookingId");

-- CreateIndex
CREATE INDEX "ledger_transactions_occurredAt_idx" ON "ledger_transactions"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_id_currency_key" ON "ledger_transactions"("id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_idx" ON "ledger_entries"("accountId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_currency_fkey" FOREIGN KEY ("transactionId", "currency") REFERENCES "ledger_transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_currency_fkey" FOREIGN KEY ("accountId", "currency") REFERENCES "ledger_accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- The rules Prisma cannot express
-- --------------------------------------------------------------------------

-- A closed two-value vocabulary that will never grow, which is what makes a
-- CHECK right here and wrong on `bookings.state`.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "entry_direction_is_known"
  CHECK ("direction" IN ('debit', 'credit'));

-- Strictly positive. ADR 0002 permits a negative `Money` because refunds need
-- one; a ledger entry is where that permission stops. The direction already
-- carries the sign, and a ledger admitting both conventions cannot be summed
-- without first deciding which one each row used.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "entry_amount_is_positive"
  CHECK ("amountMinor" > 0);

-- An empty key deduplicates nothing, and would collide with the next empty one.
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "idempotency_key_is_present"
  CHECK (length(btrim("idempotencyKey")) > 0);

-- A transaction that reverses itself nets to nothing and means nothing.
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "transaction_does_not_reverse_itself"
  CHECK ("reversesId" IS NULL OR "reversesId" <> "id");

-- The derived natural key must actually be there — see the header for why this
-- column carries the uniqueness rather than (kind, ownerId, currency).
ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "account_identity_is_present"
  CHECK (length(btrim("identity")) > 0);

-- --------------------------------------------------------------------------
-- Immutability
-- --------------------------------------------------------------------------

-- One function for all three tables. TG_TABLE_NAME and TG_OP make the message
-- specific, which matters because this is a sentence somebody will read in a log
-- while wondering what they did wrong.
CREATE FUNCTION "refuse_ledger_write"() RETURNS trigger AS $refuse$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % refused. BRD 8.7 — corrections are made by posting reversing entries, never by editing or deleting',
    TG_TABLE_NAME, TG_OP;
END;
$refuse$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_accounts_are_immutable"
  BEFORE UPDATE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION "refuse_ledger_write"();

CREATE TRIGGER "ledger_transactions_are_immutable"
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION "refuse_ledger_write"();

CREATE TRIGGER "ledger_entries_are_immutable"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "refuse_ledger_write"();

-- --------------------------------------------------------------------------
-- The balance rule
-- --------------------------------------------------------------------------

-- Deferred to COMMIT, because entries are inserted after the transaction row
-- they belong to. Fired from both tables: from `ledger_transactions` so a
-- transaction with no entries at all is caught, and from `ledger_entries` so an
-- entry appended later cannot unbalance one.
CREATE FUNCTION "assert_ledger_transaction_balances"() RETURNS trigger AS $balance$
DECLARE
  txn_id  UUID;
  entries INTEGER;
  debits  BIGINT;
  credits BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    txn_id := NEW."transactionId";
  ELSE
    txn_id := NEW."id";
  END IF;

  SELECT
    COUNT(*),
    COALESCE(SUM(CASE WHEN "direction" = 'debit'  THEN "amountMinor" ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN "direction" = 'credit' THEN "amountMinor" ELSE 0 END), 0)
  INTO entries, debits, credits
  FROM "ledger_entries"
  WHERE "transactionId" = txn_id;

  IF entries < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % entries: one entry can never balance', txn_id, entries;
  END IF;

  IF debits <> credits THEN
    RAISE EXCEPTION
      'ledger transaction % does not balance: debits % != credits %', txn_id, debits, credits;
  END IF;

  RETURN NULL;
END;
$balance$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_transaction_balances"
  AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_ledger_transaction_balances"();

CREATE CONSTRAINT TRIGGER "ledger_entry_keeps_its_transaction_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_ledger_transaction_balances"();
