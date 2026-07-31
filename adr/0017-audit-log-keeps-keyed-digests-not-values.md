# 0017. Keep keyed digests in the audit log, not values, and fail closed when it cannot be written

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates to:** BRD §6.2, §10.1, §14 Phase 1, §17 risk table

## Context

Phase 1 requires session and audit events, read-only "view as user" with audit logging, and an admin role — and the last two cannot be built at all until an audit trail exists. This slice builds the trail and gives it two real writers.

BRD §6.2 defines the entity as _actor, action, target, before/after **hash**, IP, time_, and §17's risk table asks for _immutable audit logs_ as a control against admin misuse. §10.1 retains security logs for a year hot and six years cold.

Three things about that combination are not obvious, and each one has a way of being quietly undone by somebody who does not know why it was chosen.

## Decision

### The log stores a keyed digest, and never a value

`beforeHash` and `afterHash` are **HMAC-SHA256 under a server-side key**, not the plain hash the BRD's wording suggests.

The reason for hashing at all is retention. Personal data in `users`, `profiles` and `addresses` is erasable on request; audit entries are retained for six years. Copying values into the log would mean a deletion request erases the original and leaves a longer-lived duplicate behind — inverting §10.1 rather than implementing it.

The reason for _keying_ it is that a bare hash would not survive contact with the data we actually hold. A display name has a tiny value space: anyone with this table could hash a list of plausible names and recover it offline. The digest would look like protection and provide none. Keyed, it still compares equal for equal inputs — which is the whole of what change-detection needs — and tells an offline attacker nothing.

**The key is derived from `PERSONAL_DATA_ENCRYPTION_KEY` by HKDF** with the purpose string `audit-state-digest-v1`. One secret for the operator to manage, two cryptographically independent keys, and no second environment variable to lose. Deriving it rather than reusing the master key directly means a weakness in either use does not implicate the other.

Digests cover the **content** of a record and not its timestamps. `updatedAt` moves on every save, so including it would make two saves of identical content produce different digests, and the log would claim a change every time somebody pressed save without editing anything — destroying the only property comparing digests has.

### Append-only is a property of the port, not a convention

`AuditLog` offers `record` and `listForActor`. There is no update and no delete, and `PrismaAuditLog` contains neither call. Prisma would generate either happily; what prevents it is that no code exists to invoke one, and adding one is a visible change to an interface whose comment says why it is shaped this way.

This is weaker than a database permission and we know it. When a dedicated application role arrives with the VPS, revoking `UPDATE` and `DELETE` on `audit_logs` is the belt to this braces. Until there is a role to grant, the type is the enforcement.

The migration uses `ON DELETE SET NULL` for the actor, unlike `profiles`, which uses `RESTRICT`. Accounts are soft-deleted so neither should ever fire — but if a hard delete ever reaches `users`, an audit trail that loses the _actor's name_ is far better than one that loses the _entry_. The event is what carries the retention obligation.

### Audit writes fail closed

`AuditService.record` is awaited and its failures propagate. A profile saved with no record of who changed it is precisely the outcome an audit log exists to prevent, so the audited action fails with it.

This costs less than it appears: the log shares a database with the data being changed, so a failure here means that write would have failed too. It is not a new failure mode, it is the same one.

### The client's address is forwarded, and that is the only way it can be known

**The API never sees a browser.** Only the web app joins the edge network; the API is called server-side, so its view of the connection is always the web container. Recording that would put a constant in a security log and call it evidence.

So the web app reads `X-Forwarded-For`, takes **the last entry** — the one our own ingress appended, rather than the first, which is whatever the caller chose to claim — and forwards it on a dedicated single-valued header, `x-client-ip`. The API validates it with `isIP` and records null when it cannot tell.

What makes trusting that header acceptable is the network topology rather than anything about the header itself: the API is unreachable from the internet, so only the web app can set it. That is the same trust the Clerk events endpoint already rests on.

## Alternatives rejected

**Store before/after values.** What the log would be most useful with, and it is what most people expect an audit trail to contain. Rejected on retention: it makes this table a six-year copy of data the user can have erased everywhere else, and no amount of access control fixes that.

**A bare SHA-256, as the BRD's wording implies.** Rejected because it is recoverable for the values we actually store. Recording the departure here rather than following the letter of a requirement into a weakness.

**A second environment variable for the digest key.** Cleaner separation on paper. Rejected because it is a real operational cost for a two-person team, and a key that has to be generated, stored and never lost is a liability per key. HKDF gives the same separation from one secret.

**Write the audit entry in the same transaction as the change.** Strictly better for correctness: both commit or neither does. Rejected because the port would have to accept a transaction handle from whichever module is calling, which couples every module's persistence layer to the audit module's. That is the kind of coupling that makes a boundary decorative. Fail-closed gets most of the guarantee for none of the coupling.

**Catch audit failures and continue.** Keeps the user's action working when the log is broken. Rejected: it produces unaudited changes silently, and an audit log with unknown gaps is worse than none, because it is believed.

**Trust `request.ip` at the API.** Simplest possible thing, and wrong — it is always the web container's address.

**Take the first `X-Forwarded-For` entry.** The common mistake. It is attacker-supplied whenever the client sends the header themselves.

## Consequences

**The digests are only comparable while the key lives.** Rotating `PERSONAL_DATA_ENCRYPTION_KEY` makes every pre-rotation digest incomparable with every post-rotation one. Nothing breaks — entries stay readable and the trail stays intact — but "did this value change back to what it was in March" stops being answerable across the boundary. The purpose string is versioned so a deliberate rotation can be identified rather than silently assumed.

**The address is only as good as the proxy in front.** Taking the last `X-Forwarded-For` entry is correct for exactly one trusted hop, which is what `infra/compose` deploys. **Putting a CDN in front of Caddy adds a hop and makes the last entry the CDN's** — and nothing will fail loudly when that happens, it will simply start recording the wrong address. If a CDN is ever introduced, `clientIpFrom` in the web app changes with it.

**Locally there is no proxy, so the address is null.** That is honest rather than broken, and the tests assert both paths.

**Only the actor can read their own trail.** There is no route that reads everyone's. Reading across accounts is an administrative capability and belongs with the admin role, its MFA requirement and its own audit entries — not with a query parameter added to `/me/activity` because it was convenient.

**Adding an action means editing `AuditAction`.** A closed union rather than a free string, so a typo is a compile error and the vocabulary is readable in one place. It is deliberately not a Postgres enum, which would put every new audited action in every future module behind a schema migration.

**`account.provisioned` is recorded once, by whichever call actually created the row.** `UserDirectory.upsert` reports whether it created rather than letting the caller infer it from a prior read — under concurrency that inference is simply wrong, and the log would show two accounts coming into existence where one did.
