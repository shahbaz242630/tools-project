# 0010. Expose package types from source and runtime from built output

- **Status:** Accepted
- **Date:** 2026-07-27
- **Relates to:** BRD §4, §15

## Context

Every workspace package declared `"exports": { ".": "./src/index.ts" }` — a raw TypeScript file as the entry point a consumer resolves.

Under vitest this works, because vitest transforms TypeScript and resolves a `./money.js` specifier to `money.ts`. Under Node it does not. Loading `@platform/core` in a real process produced:

```
ERR_MODULE_NOT_FOUND: Cannot find module .../packages/core/src/money.js
  imported from .../packages/core/src/index.ts
```

Node attempted type stripping, then failed on the first re-export, because type stripping does not rewrite specifiers. Every package had this. 143 unit tests passed throughout.

The defect was invisible for three slices because nothing had ever run these packages outside the test runner. It surfaced only when Phase 0.8 needed a deployable API — the first code intended to execute in production.

The underlying trap is general: **a test runner that resolves source is testing something the deployed artefact is not.**

## Decision

Packages declare both, distinguished by condition:

```json
"exports": {
  ".": {
    "types": "./src/index.ts",
    "default": "./dist/index.js"
  }
}
```

TypeScript reads types from source, so `pnpm typecheck` needs no prior build and a type error points at the line that caused it. Node loads compiled JavaScript, which is what a deployed process requires.

Vitest keeps resolving source, via explicit aliases in `vitest.config.ts`, so the suite stays build-free and fast.

`pnpm verify:runtime` imports every package through its declared runtime entry in a real Node module graph, and runs in CI immediately after the build. It reproduces the original failure when the exports are reverted — including the transitive case, where `@platform/observability` breaks because `@platform/core` is unloadable.

## Consequences

Types and runtime can drift. Source says one thing, stale `dist/` another, and the type checker believes source. `verify:runtime` catches a package that fails to load; it does not catch a signature that changed without a rebuild.

A build is now required before running anything. Forgetting it produces a clear "does not exist — run `pnpm build`" message rather than a resolution error, which is the one improvement this buys at the cost of the extra step.

The test suite still does not exercise built output. That is deliberate — the speed is worth more than the coverage — but it means `verify:runtime` is the only thing standing between us and a repeat. It must not be allowed to become optional.

## Alternatives considered

**Point `types` at `./dist/index.d.ts` too.** Removes drift entirely and is the correct choice for a published library. Rejected because typechecking would require a build first, and CI's quality job deliberately runs without one. We would trade a fast, honest type loop for a guarantee that mostly matters when strangers consume your package. Revisit if these are ever published.

**Keep source entry points and run the API through a TypeScript loader in production.** Removes the build step, and Node's type stripping makes it superficially plausible. Rejected: stripping is explicitly disabled inside `node_modules`, does not support the decorator metadata NestJS needs, and makes production behaviour depend on an experimental flag.

**Bundle each app so package resolution never happens at runtime.** Works, and is what many deployments do. Rejected for now as a larger change than the problem warrants — it adds a bundler to the toolchain to fix a two-line manifest error. Reasonable to reconsider when image size or cold start starts to matter.

**A `development` export condition instead of vitest aliases.** Equivalent in effect and arguably more idiomatic. Aliases won on legibility: one list in one file, obvious to someone who has not memorised Node's condition-resolution order.

## What would change this

If these packages are ever published outside this repository, `types` must move to `dist` and this ADR is superseded.

If type-versus-runtime drift causes a real incident, that is the signal that the fast type loop is not worth its cost, and the same change applies.
