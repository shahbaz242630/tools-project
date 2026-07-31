# 0015. Put identity at Clerk and keep a local mirror as the platform record

- **Status:** Accepted
- **Date:** 2026-07-30
- **Relates to:** BRD §6, §10, §14 Phase 1

## Context

Phase 1 needs registration, login, sessions and server-side RBAC. Three options were realistic, and cost did not separate them — all three are free at our scale.

**Better Auth** is an MIT library that would keep the authoritative user record in our own Postgres, with no vendor in the login path. **Clerk** is a hosted provider, free to 50,000 monthly retained users since February 2026. **From scratch** meant writing session handling, password reset and rehash-on-login ourselves, with no reviewer but the author.

The engineering recommendation was Better Auth, on one argument: `users` will carry foreign keys from listings, bookings, messages and the ledger, and a foreign key to a row in someone else's database is not a thing. If identity lives at Clerk, we must keep a mirror synced by webhook, and BRD §6 then requires us to define and test behaviour for provider outage and reference desynchronisation. A provider does not remove that work — it creates it.

**The product owner chose Clerk on 30 July 2026, with that trade-off stated.** This ADR records the decision and the shape it forces, not a re-argument of it.

A second constraint shaped the design more than the choice of vendor did. Our API is a NestJS service on the internal network; only the web app is on the edge, and CI asserts the API is unreachable from it. Clerk's documentation assumes the framework _is_ the application, so none of it describes this topology.

## Decision

**Clerk holds credentials and is the source of truth for identity. The `users` row is a mirror, and it is the platform record.** `users.id` is a UUID we mint; `clerkUserId` is an ordinary unique column, never the primary key. Everything the platform owns points at `users.id`, so replacing the identity provider does not orphan a single booking or ledger entry.

**The API is given the JWT _public_ key and nothing else.** `verifyToken` with `jwtKey` verifies an RS256 signature against a key already in memory. That makes verification networkless — no call to Clerk on the request path, so a Clerk outage cannot hang an authenticated request — and it means an API that is compromised yields a key Clerk already publishes at its JWKS endpoint, rather than the ability to mint sessions, read the whole user directory or impersonate anyone. The alternative, omitting `jwtKey` and letting the SDK fetch JWKS, requires `CLERK_SECRET_KEY` to do a job a public key does.

**The web app holds the secrets, because Clerk's Next SDK leaves no choice.** `clerkMiddleware()` and `auth()` need `CLERK_SECRET_KEY`, and that middleware is the application. So the internet-facing service holds a key that can read the entire user directory. That is a real cost of a hosted provider and it is written here rather than left to be discovered.

**The mirror is written two ways, deliberately.** The webhook applies creations, address changes and deletions. The guard _also_ provisions on first sight of a valid session, because Clerk delivers `user.created` asynchronously and someone who signs up and is redirected straight in would otherwise meet an error until the delivery landed. Both converge on one row because `clerkUserId` is unique.

**Just-in-time provisioning requires the email, so the instance adds it as a custom session claim.** `users.email` is `NOT NULL` and Clerk's default session token carries only `sub` and `sid`. The alternatives were both worse: asking Clerk's Backend API needs the secret key we deliberately withheld, and taking the address from the web app means trusting a caller to name its own identity. The claim arrives inside a token Clerk signed, so it is exactly as trustworthy as the subject beside it. **This is instance configuration, not code** — applied with `clerk config patch`, and recorded in the provisioning notes below because an instance that loses it authenticates nobody.

**Webhook signatures are verified in the web app; the event's meaning is decided in the API.** The delivery lands on the edge, and verification needs the raw unparsed body, which exists only there. The web app forwards the verified event inward without interpreting it; the API translates Clerk's payload shape in exactly one place and applies it idempotently against a `webhook_events` unique constraint.

**Deletion is a soft delete with a tombstoned address.** Hard deletion is unavailable — from Phase 2 the ledger references this row and can never lose its counterparty. On `user.deleted` we set `deletedAt` and replace the email with `deleted+<id>@deleted.invalid`. That frees the real address for genuine re-registration, which a retained unique row would block permanently, and removes personal data we no longer have a purpose for.

## Consequences

The identity mirror can drift, and that is now a permanent property of the system rather than a bug to be fixed. A missed webhook leaves a stale email until the next sign-in corrects it. The `webhook_events` ledger makes redelivery safe and records anything claimed but never applied.

`users` is no longer self-contained. Creating a usable account requires a Clerk account to exist, which means no seeding fixtures without one, and integration tests use fakes rather than a real instance.

**Clerk instance configuration is now load-bearing and lives outside version control.** The custom `email` claim, **the `fva` factor-verification claim** (added by ADR 0021 — without it nobody can be an administrator, because an unprovable second factor is refused) and the webhook endpoint are dashboard state. An instance without the claim produces correctly-signed tokens that this API rejects — deliberately loudly, naming the configuration, because the alternative failure is a `NOT NULL` violation that points nowhere near the cause.

Staging and production must use **different Clerk instances**. A shared one means a staging sign-up creates a production account.

The internal event endpoint is protected by network topology alone. Anything that can reach the API can forge identity events — but the same is true of Postgres sitting beside it, so this is the established trust model rather than a new exposure. It is the reason a browser-facing route must never be added to that controller.

Free to 50,000 monthly retained users, then $25/month plus $0.02 per user. Not a concern at our scale, and not the reason for the choice either way.

## Alternatives considered

**Better Auth.** Recommended and not chosen. Keeps identity in our Postgres with no vendor in the login path, makes foreign keys ordinary, and removes the mirror, the webhook and the desync handling entirely. Counter-risks that were real: about a year old, and a funded company shipping a free library eventually needs a monetisation path. MIT is irrevocable for versions we hold, so the worst case is inheriting a fork rather than an outage.

**Rolling our own.** Rejected. Session fixation, reset-token reuse, timing and rehash-on-login are all easy to get subtly wrong, and a solo maintainer has no reviewer.

**Clerk's user id as our primary key.** Rejected outright. It welds every foreign key in the platform to one vendor, and a provider that deletes an account would take the identity — and its bookings and ledger entries — with it.

**`prisma.user.upsert` for the mirror write.** Rejected. It generates `INSERT … ON CONFLICT` against a single conflict target, and this table has two independent unique constraints. A second Clerk account whose email already belongs to another mirror row must fail, not silently repoint an existing account — with foreign keys arriving in Phase 2, that would hand one person another's listings and payouts.

**Verifying webhooks in the API, with the web app proxying raw bytes.** Rejected. It keeps the signing secret off the edge service, which sounds better until you notice the web app already holds `CLERK_SECRET_KEY`, which is strictly more dangerous. Against that, proxying raw bytes adds a place for the payload to be re-encoded and the signature to stop matching, for no gain.

**Storing the webhook payload.** Rejected. Idempotency needs only the delivery id; the body carries email addresses we would then hold a second time, outside `users`, with no purpose and no retention rule — against BRD §10's data minimisation. Clerk retains the event and can redeliver it.

**Hard deletion, or a partial unique index on live rows.** Hard deletion is impossible once the ledger references the row. A partial unique index (`WHERE deleted_at IS NULL`) would preserve the address for audit and still allow re-registration, but Prisma cannot express it, so it would live as raw SQL that Prisma's drift detection then wants to drop — a maintenance trap for a solo team. Tombstoning is expressible, and erasing the address on deletion is the more defensible position under UK GDPR anyway.

**Clerk Organizations.** Not adopted. BRD §6 gives one account both renter and owner capabilities; Organizations models a different thing and would introduce a tenancy concept the domain does not have.

## Provisioning notes

An instance is not usable until all of this exists. None of it is in version control.

1. **Custom session claim.** `clerk config patch --json '{"session":{"claims":{"email":"{{user.primary_email_address}}"}}}'`. Without it every authenticated request is rejected.
2. **Webhook endpoint** at `https://<host>/api/webhooks/clerk`, subscribed to `user.created`, `user.updated` and `user.deleted`. Copy its signing secret into `CLERK_WEBHOOK_SIGNING_SECRET`.
3. **JWT public key** into `CLERK_JWT_PUBLIC_KEY`, derived from the published JWKS — see the one-liner in `.env.example`.
4. **`CLERK_AUTHORIZED_PARTIES`** set to that environment's public web origin.

Session tokens are issued with a 60-second lifetime and 5 seconds of allowed clock skew, which is why the web app mints a fresh one per request rather than caching.

## What would change this

Clerk changing its free tier such that our economics stop working, or an outage record that makes a vendor in the login path unacceptable. Either triggers a move to Better Auth — which the mirror is what makes survivable, because `users.id` never depended on Clerk.

Sooner and more likely: if the desync handling here turns out to cost more than the library would have, revisit before Phase 5 wires payouts to these identities, not after.
