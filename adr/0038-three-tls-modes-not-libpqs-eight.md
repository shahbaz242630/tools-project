# 0038. Accept three Postgres TLS modes, not libpq's eight

- **Status:** Accepted
- **Date:** 2026-08-09
- **Relates to:** ADR 0006, ADR 0037, ADR 0014; BRD §10, §12.4
- **Slice:** 0.9c

## Context

ADR 0037 recorded that `buildPostgresUrl` cannot express `sslmode`, and that this is why the
applications cannot start against Neon while `psql` connects to it happily. Adding the field is
five lines. Deciding **which values it accepts** is the part that needed a decision, and it turned
out to be a larger question than the one that prompted it.

`pg-connection-string@2.14.0` — the version installed today, reached through `pg@8.22.0` and
`@prisma/adapter-pg` — was run against every mode. It prints its own warning:

> SECURITY WARNING: The SSL modes `prefer`, `require`, and `verify-ca` are treated as aliases for
> `verify-full`. In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these
> modes will adopt standard libpq semantics, which have weaker security guarantees.

Parsed results, from running it rather than reading about it:

| Written       | Parsed today                  | After pg 9                              |
| ------------- | ----------------------------- | --------------------------------------- |
| `disable`     | `false` — no TLS              | unchanged                               |
| `allow`       | `{}` — verify-full            | **plaintext unless the server insists** |
| `prefer`      | `{}` — verify-full            | **plaintext if TLS is unavailable**     |
| `require`     | `{}` — verify-full            | **encrypted, certificate unchecked**    |
| `verify-ca`   | `{}` — verify-full            | **chain checked, hostname not**         |
| `verify-full` | `{}` — verify-full            | unchanged                               |
| `no-verify`   | `{rejectUnauthorized: false}` | unchanged                               |
| `nonsense`    | `{}` — verify-full            | —                                       |

Two findings matter more than the warning itself.

**Four values change meaning, not one.** ADR 0037 named only `require`. `prefer`, `allow` and
`verify-ca` weaken in the same release, and `prefer` weakens furthest: it silently accepts a
plaintext connection.

**An unrecognised value is not an error.** `sslmode=verifyfull` parses to `{}` — TLS on, no
complaint from any layer. So a typo in the one field that decides whether database traffic is
verified produces a working connection and a false sense of what it is.

Three values mean the same thing before and after: `disable`, `no-verify`, `verify-full`. Between
them they cover every intent anybody has: no TLS, TLS without checking who answered, TLS with the
chain and hostname checked. Nothing is lost by having only those three, because the two meanings
that `require` might carry each already have an unambiguous word.

## Decision

**`POSTGRES_SSLMODE` accepts `disable`, `no-verify` and `verify-full`. Every other value is
refused at startup**, with a message naming the replacement.

- **Refusal, not correction.** `require` does not quietly become `verify-full`. A process running
  under a setting different from the one somebody configured is the situation ADR 0030 refuses for
  the same reason.
- **Required when `NODE_ENV=production`.** Unset composes a URL with no TLS instruction at all,
  which against a managed database is a plaintext connection over the internet that nobody chose.
  `disable` remains a legitimate answer over a private network — it just has to be typed.
- **Optional everywhere else, and an unset value composes the URL this project has always
  composed**, byte for byte. The local Postgres container speaks no TLS and neither the dev stack
  nor the integration suite changes.
- **An empty value is absent.** `POSTGRES_SSLMODE=` in an env file and an unset variable are the
  same intent, and Compose can only spell one of them.
- **The rule is duplicated in `packages/database/prisma.config.ts`**, which cannot import
  `@platform/config` (ADR 0014). That file now carries two copied rules rather than one, and it
  gained its first test in this slice.

## Consequences

**The value that most documentation tells you to write is refused.** Every Neon, Supabase and
Postgres tutorial says `?sslmode=require`. Somebody will hit this, and the error message is
therefore part of the decision rather than a nicety: it names `verify-full` and says why.

**Migrations and the application can no longer disagree.** They were already able to — the Prisma
engine connected to Neon while node-postgres refused it, which is how 23 migrations landed against
a database no application could open. Compose now requires the same `POSTGRES_SSLMODE` for the
`migrations`, `api` and `worker` services, so a green migration step stops being mistakable for a
working deploy.

**`prisma.config.ts` is typechecked and tested for the first time.** It sat at the package root,
outside the tsconfig `include` and outside every vitest project, while holding the only copy of
two rules it must keep in step with `@platform/config`. It is now in `include` and excluded from
the build emit, and has eleven tests.

**The CI container-image job needed the variable.** Both images set `NODE_ENV=production`, so the
liveness check would have stopped booting. It passes `disable`, which is honest — that container
reaches no database at all.

**A fourth value will eventually be wanted.** `verify-ca` has a real use — verifying a private CA
without pinning the hostname — and it is deliberately absent because nothing needs it today. Add
it with its libpq meaning stated, not as an alias.

## Alternatives considered

**Pass through whatever the driver accepts.** Smallest change, and it is what the handoff note
asked for: add the field, write `verify-full` in the deployed environment, document that `require`
is wrong. Rejected because the documentation would be the only control, and the failure it guards
against — a dependency bump silently downgrading TLS — is invisible by construction. A comment
does not fail a build.

**Refuse `require` only in production.** Would let local development use the value the tutorials
give. Rejected because it makes the vocabulary environment-dependent for no gain: development
against Neon wants verified TLS too, and a value that works locally and is refused on deploy is
found at the worst moment.

**Default production to `verify-full` instead of requiring the field.** Secure by default and one
less thing to configure. Rejected on the ADR 0030 reasoning: a default is invisible, and the first
environment that genuinely needs `disable` — a private network, a local socket — would discover
the override somewhere much further from here. Making the insecure choice typed is the point.

**Adopt libpq semantics now with `uselibpqcompat=true`**, as the warning suggests. It settles the
ambiguity in the other direction, and it settles it toward the weaker reading. We would rather not
have the ambiguous words at all.

**Validate in `buildPostgresUrl` rather than in the schema.** Rejected because the schema reports
every environment problem at once and a throwing helper reports one per restart, which is the
behaviour `loadEnv` exists to prevent.

## What would change this

Revisit when `pg` 9 lands: the warning disappears, the three chosen values keep their meanings,
and `require` becomes unambiguous — differently, but unambiguously. It could then be accepted with
its libpq meaning, though `no-verify` already says that and more clearly. Revisit if a private CA
is introduced, which is what makes `verify-ca` worth adding. And revisit the production
requirement if a deployment appears where the database is reached over a unix socket, where the
whole field is meaningless.
