---
name: new-module
description: Scaffold a domain module with the boundaries BRD §5.1 requires. Use when adding a new bounded context such as booking, catalogue or disputes.
---

# New domain module

Modules are listed in BRD §5.1 with explicit "must not own" columns. Read that row before starting — the exclusions matter more than the inclusions.

## Structure

```
<module>/
  domain/         entities, value objects, state machines. No I/O, no framework.
  application/    use cases orchestrating domain + ports
  ports/          interfaces this module needs from outside
  adapters/       implementations of those ports
  api/            controllers, routes, DTOs
  <module>.module.ts
```

Dependencies point inward. `domain/` imports nothing from the outer layers — if it needs a framework import, the logic is in the wrong place.

## Boundary rules

- **No direct cross-module database writes.** Ever. Modules talk through application services, defined interfaces or domain events.
- **No importing another module's `domain/` or `adapters/`.** Only its public application service.
- A module owning a foreign key is not the same as owning that data. Booking references a listing; it does not write to one.

If two modules keep needing each other's internals, the boundary is drawn in the wrong place. Say so and propose a redraw — do not quietly reach across.

## Checklist

- [ ] Owns exactly what BRD §5.1 says, and nothing from its "must not own" column
- [ ] Public surface is one application service, not a package of exports
- [ ] Domain layer has no framework or ORM imports
- [ ] State transitions validated centrally, never inferred from a UI action
- [ ] Authorisation checked server-side on every operation, with tests proving both permitted and forbidden access
- [ ] Domain events published for anything another module needs to react to
