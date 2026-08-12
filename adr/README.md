# Architecture decision records

Short documents recording decisions that shaped the codebase, and — more importantly — **why**. The code shows what we did. These say what we rejected and what would make us change our minds.

BRD §11.3 requires an ADR when a slice makes an architectural decision, and §15 requires one before deviating from a mechanism the BRD marks normative.

## Why these live here and not in `docs/`

`docs/` is gitignored: it holds the BRD, the handoff and commercial strategy that stay private. ADRs explain committed code, so they must travel with it. Anyone reading this repository — including a future maintainer, or me in a fresh session — needs the reasoning without needing the private folder.

## Writing one

Copy `template.md`, take the next number, keep it under a page. An ADR nobody reads is worse than none, because it implies a decision was considered when it was only recorded.

Record a decision when it is **hard to reverse**, **surprising without context**, or **something a reasonable engineer would otherwise undo**. Do not record routine choices — a linting rule is not an ADR.

## Status values

| Status     | Meaning                                      |
| ---------- | -------------------------------------------- |
| Proposed   | Under discussion, not yet acted on           |
| Accepted   | In force; the code reflects it               |
| Superseded | Replaced — links to the ADR that replaced it |
| Deprecated | No longer applies, with nothing replacing it |

Never delete or rewrite an accepted ADR. Supersede it, so the reasoning trail survives. A decision that looks wrong later is usually a decision whose context changed, and that context is the useful part.

## Index

| #                                                                                   | Decision                                                                          | Status                                     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| [0001](0001-record-architecture-decisions.md)                                       | Record architecture decisions                                                     | Accepted                                   |
| [0002](0002-money-as-integer-minor-units.md)                                        | Money as integer minor units, with explicit allocation for splits                 | Accepted                                   |
| [0003](0003-rental-duration-in-calendar-days.md)                                    | Count rental duration in local calendar days, not elapsed time                    | Accepted                                   |
| [0004](0004-database-enforced-booking-overlap.md)                                   | Prevent double booking in the database, not the application                       | Accepted                                   |
| [0005](0005-brand-name-in-one-module.md)                                            | Confine the brand name to a single configuration module                           | Accepted                                   |
| [0006](0006-compose-connection-strings-at-runtime.md)                               | Compose connection strings at runtime rather than committing them                 | Accepted                                   |
| [0007](0007-correlation-via-async-local-storage.md)                                 | Carry correlation context in AsyncLocalStorage                                    | Accepted                                   |
| [0008](0008-defer-provider-adapters-without-credentials.md)                         | Do not write a provider adapter before it can be exercised                        | Accepted                                   |
| [0009](0009-self-hosted-vps-with-off-box-backups.md)                                | Self-host on a VPS, with database backups off the box                             | Accepted — hosting half superseded by 0037 |
| [0010](0010-packages-expose-source-types-and-built-runtime.md)                      | Expose package types from source and runtime from built output                    | Accepted                                   |
| [0011](0011-api-is-commonjs-in-an-esm-workspace.md)                                 | Build the API as CommonJS inside an ESM workspace                                 | Accepted                                   |
| [0012](0012-immutable-image-tags-and-compose-deploys.md)                            | Deploy immutable image tags, run them with Compose behind Caddy                   | Accepted                                   |
| [0013](0013-web-is-bundler-resolved-in-a-nodenext-workspace.md)                     | apps/web resolves modules as a bundler, not as Node                               | Accepted                                   |
| [0014](0014-prisma-lives-in-a-package-and-migrations-ship-as-an-image.md)           | Prisma lives in a package, migrations ship as an image                            | Accepted                                   |
| [0015](0015-identity-lives-at-clerk-with-a-local-mirror.md)                         | Put identity at Clerk and keep a local mirror as the record                       | Accepted                                   |
| [0016](0016-profiles-publish-a-district-not-an-address.md)                          | Publish a postal district, gate contact data behind a booking                     | Accepted                                   |
| [0017](0017-audit-log-keeps-keyed-digests-not-values.md)                            | Keep keyed digests in the audit log, not values, and fail closed                  | Accepted                                   |
| [0018](0018-delete-our-data-before-the-credential.md)                               | Erase our data before deleting the credential, and say what survives              | Accepted, corrected 2026-08-02             |
| [0019](0019-the-export-is-the-one-plaintext-egress.md)                              | Treat the data export as the one plaintext egress, and audit it                   | Accepted                                   |
| [0020](0020-email-correction-stays-at-the-provider.md)                              | Correct the email at the provider, and let the mirror converge                    | Accepted                                   |
| [0021](0021-admin-access-requires-a-second-factor-and-a-reason.md)                  | Require a second factor and a stated reason for admin access                      | Accepted, corrected 2026-08-01             |
| [0022](0022-view-as-user-is-a-projection-not-a-session.md)                          | Build "view as user" as a read-only projection, never a session                   | Accepted                                   |
| [0023](0023-role-changes-need-two-administrators.md)                                | Require two administrators to change a role, enforced in the database             | Accepted                                   |
| [0024](0024-suspension-keeps-data-rights-and-takes-one-administrator.md)            | Suspension takes one administrator and keeps data rights                          | Accepted                                   |
| [0025](0025-authentication-events-are-their-own-table.md)                           | Keep authentication events in their own table, not in the audit log               | Accepted                                   |
| [0026](0026-suspicious-login-alerting-stays-with-the-provider.md)                   | Leave suspicious-login alerting with the provider until we can send               | Accepted                                   |
| [0027](0027-category-attributes-are-a-closed-typed-vocabulary.md)                   | Make category attributes a closed typed vocabulary, not JSON Schema               | Accepted                                   |
| [0028](0028-reporting-scope-is-confirmed-per-request-and-its-entity-stays-empty.md) | Confirm reporting scope per request, keep the tax profile empty                   | Accepted                                   |
| [0029](0029-attribute-values-are-read-against-the-pinned-version.md)                | Read attribute values against the pinned version, refuse a stale form             | Accepted                                   |
| [0030](0030-a-development-escape-hatch-for-the-admin-second-factor.md)              | Give the admin second factor a development escape hatch                           | Accepted — remove with Clerk Pro           |
| [0031](0031-the-transport-requirement-is-a-platform-vocabulary.md)                  | Make the transport requirement a platform vocabulary a category picks             | Accepted                                   |
| [0032](0032-the-listing-fuzz-offset-is-random-and-stored.md)                        | Draw the listing fuzz offset at random and store it, never derive it              | Accepted                                   |
| [0033](0033-fee-rates-are-integer-basis-points.md)                                  | Store fee rates as integer basis points, never a float or a percent               | Accepted                                   |
| [0034](0034-pricing-is-its-own-module.md)                                           | Open a pricing module, though BRD §5.1's table does not list one                  | Accepted                                   |
| [0035](0035-list-reads-are-bounded-by-what-the-collection-is.md)                    | Bound every list read, choosing the bound by what the collection is               | Accepted                                   |
| [0036](0036-feature-flags-are-audited-but-not-versioned.md)                         | Audit feature flags rather than versioning them; their vocabulary is code         | Accepted                                   |
| [0037](0037-managed-postgres-with-self-hosted-applications.md)                      | Run Postgres managed on Neon, applications on our own box                         | Accepted — supersedes 0009's hosting half  |
| [0038](0038-three-tls-modes-not-libpqs-eight.md)                                    | Accept three Postgres TLS modes, not libpq's eight                                | Accepted                                   |
| [0039](0039-the-deployment-stack-carries-a-database-it-never-runs.md)               | Keep a database in the deployment stack that no environment runs                  | Accepted                                   |
| [0040](0040-the-ci-deploy-key-cannot-open-a-shell.md)                               | Restrict the CI deploy key to a forced command                                    | Accepted                                   |
| [0041](0041-moderation-state-is-not-a-listing-status.md)                            | Keep moderation state in its own field, beside the owner's status                 | Accepted                                   |
| [0042](0042-a-listing-pins-its-questions-not-its-fees.md)                           | Pin a listing's questions, not its fees; re-pin by editing, not by asking         | Accepted — supersedes 0029's open question |
| [0043](0043-trader-status-belongs-to-the-person-not-the-listing.md)                 | Private-owner or professional-trader status lives on the account, not the listing | Accepted — amends BRD §8.3                 |
