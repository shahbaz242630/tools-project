-- Migration: authentication_events
--
-- BRD §8.1 asks for "authentication events, device/session management and
-- suspicious-login alerts". This is the first: the record a person reads to
-- answer "has anybody else been in my account". Slice 1.11a, ADR 0025.
--
-- Why a new table rather than more `audit_logs` rows
-- -------------------------------------------------
-- `audit_logs` deliberately stores keyed digests rather than values, which is
-- what lets it be retained for six years without holding personal data
-- (ADR 0017). An authentication event is worthless under that rule — nobody
-- recognises an intruder from an HMAC. It needs the browser and the address in
-- plain form, which is a different retention and disclosure position, so it
-- gets a different table rather than five columns that every other audited
-- action leaves null.
--
-- What a webhook actually carries
-- ------------------------------
-- The address comes from `event_attributes.http_request.client_ip`, and the
-- browser and device are parsed by us from the user agent beside it. There is
-- **no city or country**, because a session webhook carries none: Clerk
-- resolves those only on its Backend API, which needs `CLERK_SECRET_KEY` — the
-- key ADR 0015 deliberately withholds from this service.
--
-- Columns for them existed in the first draft of this migration and were folded
-- out before it was ever deployed, once real deliveries proved the shape. The
-- Backend API's session object *does* carry a `latest_activity` with all of it,
-- and building against that rather than against a real webhook is the mistake
-- ADR 0025 records.
--
-- Data impact
-- -----------
-- One new table. No existing table is altered, no column changes type, nothing
-- is backfilled and no existing row is read or rewritten. An empty table on a
-- database that has never seen a session webhook is the correct starting state:
-- history begins when the subscription is enabled, and the export says so
-- rather than implying we hold sign-ins from before we recorded any.
--
-- The foreign key is ON DELETE RESTRICT (Prisma's default for a required
-- relation) and that is deliberate. Accounts are soft-deleted, so it cannot
-- fire in production. It fires in tests: any `beforeEach` that clears `users`
-- must now clear this table first. Four unrelated test files broke the last
-- time a RESTRICT key arrived (`admin_approvals`) and the fix is the same one —
-- children before parents, in every file, not only the new one.
--
-- Erasure nulls the activity columns and keeps the row. §10.1 retains security
-- logs six years, and "a sign-in happened at 14:02" is the retainable skeleton;
-- "from Edge on Windows at 2.49.99.113" is the personal data that goes. Keeping
-- the row is also what stops the RESTRICT key turning an erasure into a failure.
--
-- Rollback
-- --------
-- `DROP TABLE "authentication_events";` — no other object depends on it and no
-- other table was touched, so the rollback is complete and leaves no orphan.
-- It discards every recorded sign-in, which is the only loss and is
-- unrecoverable: Clerk retains its own session records but we would have to
-- re-derive ours from redelivered webhooks, and Clerk does not redeliver on
-- request beyond its own retention window.
--
-- Backup first? Yes, if the table holds anything. There is no forward path back
-- to this data.
--
-- The CHECK constraint
-- --------------------
-- The event vocabulary is closed in the database as well as in the mapper, for
-- the ADR 0004 reason: a rule that lives only in application code is a rule the
-- next code path forgets. Here the cost of forgetting is a row the activity
-- page cannot label, which it would then render as a blank line in a security
-- record. Postgres refuses it instead.
--
-- Text plus a CHECK rather than a Postgres enum, because an enum puts every
-- future value behind a schema migration — the same trade `audit_logs.action`
-- makes, except that column is open by design and this one is not.
--
-- These four are what `SessionWebhookEvent` in @clerk/backend types, and what
-- we subscribe to. **Clerk's event catalogue also lists `session.pending`**,
-- which that union omits — found in the Svix portal while subscribing, not in
-- the SDK. We neither subscribe to it nor map it, so it cannot reach this
-- column; the mapper returns null for it, which is the ordinary no-op path for
-- any event type we do not act on. If pending sessions ever matter, this
-- constraint is what has to change first.

-- CreateTable
CREATE TABLE "authentication_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clerkSessionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" INET,
    "browserName" TEXT,
    "browserVersion" TEXT,
    "deviceType" TEXT,
    "isMobile" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authentication_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authentication_events_userId_occurredAt_idx" ON "authentication_events"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "authentication_events_clerkSessionId_event_key" ON "authentication_events"("clerkSessionId", "event");

-- AddForeignKey
ALTER TABLE "authentication_events" ADD CONSTRAINT "authentication_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The four events Clerk can send, and nothing else. Not generated by Prisma.
ALTER TABLE "authentication_events" ADD CONSTRAINT "event_is_known"
    CHECK ("event" IN ('started', 'ended', 'removed', 'revoked'));
