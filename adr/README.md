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

| #                                                              | Decision                                                          | Status   |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)                  | Record architecture decisions                                     | Accepted |
| [0002](0002-money-as-integer-minor-units.md)                   | Money as integer minor units, with explicit allocation for splits | Accepted |
| [0003](0003-rental-duration-in-calendar-days.md)               | Count rental duration in local calendar days, not elapsed time    | Accepted |
| [0004](0004-database-enforced-booking-overlap.md)              | Prevent double booking in the database, not the application       | Accepted |
| [0005](0005-brand-name-in-one-module.md)                       | Confine the brand name to a single configuration module           | Accepted |
| [0006](0006-compose-connection-strings-at-runtime.md)          | Compose connection strings at runtime rather than committing them | Accepted |
| [0007](0007-correlation-via-async-local-storage.md)            | Carry correlation context in AsyncLocalStorage                    | Accepted |
| [0008](0008-defer-provider-adapters-without-credentials.md)    | Do not write a provider adapter before it can be exercised        | Accepted |
| [0009](0009-self-hosted-vps-with-off-box-backups.md)           | Self-host on a VPS, with database backups off the box             | Accepted |
| [0010](0010-packages-expose-source-types-and-built-runtime.md) | Expose package types from source and runtime from built output    | Accepted |
| [0011](0011-api-is-commonjs-in-an-esm-workspace.md)            | Build the API as CommonJS inside an ESM workspace                 | Accepted |
