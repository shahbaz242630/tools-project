# 0025. Keep authentication events in their own table, not in the audit log

- **Status:** Accepted
- **Date:** 2026-08-02
- **Relates to:** BRD §8.1, §10.1, §11.1; ADR 0015, ADR 0017, ADR 0022, ADR 0024

## Context

BRD §8.1 asks for "authentication events, device/session management and
suspicious-login alerts". Slice 1.11a builds the first of the three: the record
a person reads to answer "has anybody else been in my account".

Two facts about the provider shaped it, both established against the real SDK
and the live development instance rather than from documentation, which does not
cover session payloads.

**`SessionWebhookEvent` in `@clerk/backend` types four session webhooks** —
`session.created`, `session.ended`, `session.removed` and `session.revoked`.

**Clerk's event catalogue contains a fifth, `session.pending`**, which that union
omits. It was found in the Svix portal while subscribing the endpoint, _after_
this ADR was first written asserting the four were everything — a reminder that
an SDK's typed union is what the SDK supports, not necessarily what the provider
emits. We do not subscribe to it and do not map it. Clerk's pending-session
state exists for post-sign-in tasks such as choosing an organisation, which this
domain does not have (ADR 0015 declined Clerk Organizations).

**Their payload carries the device and the place.** `latest_activity` holds
`ip_address`, `city`, `country`, `browser_name`, `browser_version`,
`device_type` and `is_mobile`. A real session on the development instance
returned Edge on Windows from Dubai with an IPv6 address — which is what makes
the feature worth building, because a sign-in record without a device or a place
tells a person nothing they can act on. Every field is optional, including the
whole `latest_activity` object.

The obvious home was `audit_logs`, which already has an append-only port, a
person's activity page, and a data export. It is the wrong home, and the reason
is a direct consequence of ADR 0017.

## Decision

**Authentication events live in `authentication_events`, owned by Identity &
Access, and are not `audit_logs` rows.**

`audit_logs` stores keyed digests rather than values, deliberately, so it can be
retained for the six years §10.1 requires without holding personal data
(ADR 0017). An authentication event is the exact inverse: it is worthless unless
it holds the city, the browser and the address in plain form, because nobody
recognises an intruder from an HMAC. Two records with opposite retention and
disclosure properties want two tables — and the alternative, seven columns that
twenty-five other audited actions leave null, is the optional-field trap ADR 0016
rejected for profiles.

**Erasure redacts rather than deletes.** On account deletion the activity columns
are nulled and the rows stay. "A session started at 14:02" is the skeleton §10.1
can honestly retain; "from Edge on Windows in Dubai" is the personal data that
goes. Keeping the row also stops the `ON DELETE RESTRICT` foreign key turning an
erasure into a failure.

**The event vocabulary is closed in the database as well as in the mapper**, by a
`CHECK` constraint over four values. ADR 0004's reasoning: a rule that lives only
in application code is one the next code path forgets, and here the cost of
forgetting is a row the activity page cannot label.

**Identity serves its own endpoint and the page merges.** `/me/activity` belongs
to the audit module, and identity already depends on audit in order to record.
Having audit read back from identity would close a cycle between two modules, so
`/me/sign-ins` is served by identity and the account activity page renders both.
The person still reads one history; the modules stay acyclic.

**A session event for an account we do not mirror is dropped, with a warning.**
Clerk delivers `user.created` and `session.created` independently and neither is
ordered against the other — the race that just-in-time provisioning exists for
(ADR 0015). Throwing is worse than dropping: the delivery is claimed in the
`webhook_events` ledger before `apply` runs, so a retry is refused as a duplicate
and the event is lost anyway, while leaving an unprocessed ledger row that
nothing watches.

**There is no administrative view of somebody's sign-ins.** ADR 0022 made the
admin projection the narrowest thing that helps support — no street lines, no
phone number. A person's location and device history is not in that category.

## Consequences

The activity page makes two API calls instead of one, concurrently. One failing
does not take the other down, and each renders its own outcome.

`authentication_events` is a **third** place a module holds personal data, after
`profiles` and `addresses`. It is inside Identity & Access, which already
implements the erasure and export obligations, so no new port was needed — but
ADR 0019's weak point stands and gets slightly worse: nothing forces a new module
to implement either.

**Nothing prunes the table.** One row per sign-in, retained six years, with no
scheduler to expire them. At our scale this is theoretical; it is written in the
migration and the handoff so it is not discovered later as a surprise.

The data export gained a `signIns` section and `EXPORT_SCHEMA_VERSION` went to 2.
That version exists so an old file is distinguishable from a malformed one, and a
newly required field is exactly the case it is for.

**Losing the first sign-in of a brand-new account is possible**, in the
milliseconds between Clerk creating the session and the account's first
authenticated request provisioning the mirror. Bounded and small, and that
account's creation is recorded as `account.provisioned` regardless.

**One provisioning step is added to every Clerk instance**: the webhook endpoint
must subscribe to the four `session.*` events. An instance without it produces no
sign-in history at all and no error — the page simply stays empty, which is the
one failure mode this feature must not have silently. It joins the `email` claim
and the `fva` claim in ADR 0015's list.

There is **no Backend API for the subscription** — `clerk api ls webhook` offers
only create/delete the Svix app. The route that does work without a browser
login is `POST /v1/webhooks/svix_url`, which mints a **pre-authenticated Svix
portal URL**; the endpoint's subscribed events are edited there. Applied to the
development instance on 2 August 2026. Note for anyone running the CLI from Git
Bash on Windows: `MSYS_NO_PATHCONV=1` is required, or the leading `/` of the
path is rewritten into a Windows path and every call answers 404.

## Alternatives considered

**Four session actions on `AuditAction`, in `audit_logs`.** Cheapest by far — the
port, the activity page and the export all exist. Rejected on the retention
argument above. The variant that keeps the digests and drops the device and place
was rejected for a simpler reason: it produces a page that says "you signed in"
and nothing else, which answers none of the questions the feature exists for.

**A separate `/account/security` page.** Closest to how most products present
this, and rejected because it makes somebody look in two places to answer one
question — "has anything odd happened to my account" — which is the question the
whole trail exists to answer.

**Deleting the rows on erasure instead of redacting them.** Simpler, and it
throws away the security log §10.1 requires be retained. It also fights the
`RESTRICT` foreign key for no gain.

**Provisioning the mirror from the session payload** when the race is lost. The
payload does carry a `user` object, so it would work — sometimes. The field is
nullable, so it fixes only some cases, and it adds a third code path that can
create an account. Two already needed justifying.

**A Postgres enum for the event.** Rejected for `AuditLog.action`'s reason: an
enum puts every new value behind a schema migration. Text plus a CHECK gives the
same guarantee here because the set is small and closed by us.

**Subscribing to `session.pending` as well.** Rejected. The mapper would return
null for it and the delivery would be a no-op, so it buys nothing but traffic
and a row in the webhook ledger for an event we have no meaning for. Pending
sessions exist for post-sign-in tasks this domain does not have. Worth revisiting
only if one is ever introduced.

**Overwriting on a replayed delivery** (`upsert` with a populated `update`).
Rejected: the first record is the one that was true at the time, and letting a
redelivery rewrite a security record silently is the opposite of what the table
is for.

## What would change this

If a later slice needs sign-in history joined to audit entries in one query —
ordered, paginated, filtered together — the two-table split starts costing more
than it saves, and a single timeline table with a discriminator becomes the
better shape. Nothing needs that today; the page merges two short lists.

If Clerk stops populating `latest_activity`, or starts populating it only after
the session's first use, the value of the `started` row drops sharply and the
useful event becomes `session.ended`. Every column is already nullable, so that
is a presentation change rather than a migration.

Suspicious-login **alerting** is deliberately not here. Clerk sends its own
new-device emails and we have no email channel of our own (slice 1.3 is
undecided); when we do, the detection this table makes possible is where that
alert would be built, and it gets its own ADR.
