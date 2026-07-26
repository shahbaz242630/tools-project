# 0006. Compose connection strings at runtime rather than committing them

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §10, §12.4

## Context

`.env.example` originally carried complete connection strings:

    DATABASE_URL=postgresql://rental:local_dev_only@localhost:5433/rental_dev
    TEST_DATABASE_URL=postgresql://rental:local_dev_only@localhost:5433/rental_test

Convenient — copy the file and everything works — but it put the password in three places in one file and left two credential-shaped strings in a public repository. A secret scanner flagged both, correctly by pattern even though the values are worthless.

Dismissing the alert was possible. It would also have trained us to dismiss the next one.

There is a separate correctness problem. A hand-written connection string breaks when the password contains `@`, `:`, `/` or `#` — the URL parses as something else entirely, and the resulting connection failure points nowhere near the cause. Local passwords are chosen to be safe; generated production passwords are not.

## Decision

`.env.example` contains no connection strings. Only the individual parts: host, port, user, password, database name.

`@platform/config` composes `DATABASE_URL` and `REDIS_URL` at runtime from those parts, percent-encoding the user, password and database name.

`redactUrl` replaces the password before any URL reaches a log, and `describeEnv` is the safe way to log configuration at startup.

## Consequences

Each credential appears exactly once. There is no committed string that looks like a credential, so scanner findings are signal rather than noise.

Special characters in passwords are handled correctly and provably — there is a round-trip test asserting a password containing `@`, `:`, `/` and `#` survives intact.

Prisma reads `DATABASE_URL` directly from the environment for CLI migrations, so when Prisma arrives it will need a wrapper that composes the URL and passes it through. That cost is accepted; it is a small script against a class of leak.

`cp .env.example .env` still works unchanged for local development.

## Alternatives considered

**Keep the templates and allowlist them in the scanners.** One dashboard action, and it normalises dismissing security alerts. Also leaves the percent-encoding bug in place.

**Commit a template with an obvious dummy password.** Still matches on pattern, so the scanner noise remains, and the encoding problem is untouched.

**Require every environment to supply a full `DATABASE_URL`.** Fewer moving parts, but pushes correct percent-encoding onto whoever writes the deployment configuration — which is the exact mistake we are trying to make impossible.

## What would change this

A managed provider that issues an opaque connection string we cannot decompose would need a documented escape hatch: accept a full URL when one is supplied, and compose only when it is not.
