---
name: slice
description: Run one vertical slice end to end under the BRD §15 discipline — restate, build, test, report, stop. Use when starting any new unit of feature work.
---

# Vertical slice

One slice at a time, inside the approved phase only. Do not begin the next slice without approval.

## 1. Restate before writing code

State plainly, and wait if anything is unclear:

- **The slice** — the smallest coherent thing that delivers value on its own.
- **Modules touched** — from BRD §5.1. Flag any new cross-module dependency and why an interface or domain event was not used instead.
- **Data changes** — migration, data impact, rollback note. "None" is valid.
- **API contract** — request and response shapes, error codes.
- **Tests** — which layers from BRD §11.1, and the specific failure modes being covered.
- **Security** — what new input is trusted, what new data is stored, who can reach it.

If the slice cannot be described in a short paragraph, it is too big. Split it.

## 2. Check the constraints first

- Read `adr/` for anything touching money, time, bookings, config or logging. Several decisions look wrong without their context.
- Check BRD §15 for mechanisms marked normative. Deviating needs an ADR **before** the code, not after.

## 3. Build

- Tests alongside implementation, not after. Reproduce every bug with a failing test before fixing it.
- Business logic in domain and application services — never in UI components, route handlers or ORM models.
- No hard-coded category names, fees, radii, deposit bands or status labels.
- Money is integer minor units. Timestamps are UTC. Providers sit behind adapters.
- No dead controls: every tab, button and link either calls real behaviour or is visibly feature-flagged.

## 4. Verify before claiming done

Run all of these and report actual output, not intent:

```
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
pnpm test:coverage
pnpm invariants
```

A green check is not evidence a check ran. If something passed suspiciously fast, read the log and confirm what it actually did.

## 5. Report, then stop

Produce the BRD §15.1 completion report: implemented, architecture, database, security, tests, manual verification steps, observability, known limitations, approval request.

State what you deliberately did **not** do, so a reviewer does not read an intentional omission as an oversight.

Then stop and wait for approval. Do not roll into the next slice.

## 6. Keep the record current

Update `docs/HANDOFF.md`: task list, decisions log with reasoning, and a session entry. Add an ADR for any decision that is hard to reverse or surprising without context.
