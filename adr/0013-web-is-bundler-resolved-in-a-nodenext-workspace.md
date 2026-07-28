# 0013. apps/web resolves modules as a bundler, not as Node

- **Status:** Accepted
- **Date:** 2026-07-28
- **Relates to:** BRD §4, §5.1 — the same class of divergence as [0011](0011-api-is-commonjs-in-an-esm-workspace.md)

## Context

`tsconfig.base.json` sets `module: NodeNext` and `moduleResolution: NodeNext`. That is correct for everything Node loads directly: it models real Node resolution, so a package that typechecks can actually be imported, which is the failure [ADR 0010](0010-packages-expose-source-types-and-built-runtime.md) was written about.

`apps/web` is not loaded by Node directly. Next compiles it with Turbopack.

The compatibility gate run before this slice tested Next 16.2.12 against the base and it passed — the app built, imported the ESM `@platform/*` packages, and rendered them. That result was incomplete, because the probe never imported anything from Next itself.

`import Link from 'next/link'` does not resolve under NodeNext. Next ships no `exports` map, so Node's ESM resolution for a subpath falls back to a literal file path and requires the extension — `next/link.js`. TypeScript is modelling Node correctly. It is simply not how the code is actually loaded, and every Next import (`next/link`, `next/navigation`, `next/image`) has the same problem.

## Decision

`apps/web` sets `module: esnext` and `moduleResolution: bundler`, overriding the workspace base.

Consequently its **relative imports carry no file extension** — `./readiness`, not `./readiness.js` — which is the opposite of the convention everywhere else in the repository. Under `bundler` the extensionless form is correct and the `.js` form fails to resolve, because there is no `readiness.js` on disk.

Four further overrides come from Next rather than from resolution: `jsx: preserve`, `noEmit: true`, `composite: false` (composite requires emit, which `noEmit` forbids) and `isolatedModules: true`.

Workspace packages still resolve correctly: `bundler` reads the `exports` map, which is how `@platform/*` declare types from source and runtime from `dist`.

## Consequences

Two apps now diverge from the base in different directions — `apps/api` towards CommonJS for NestJS decorator metadata (ADR 0011), `apps/web` towards bundler resolution for Next. Neither is drift. Both exist because the base models Node, and neither app is run by Node in the way the base assumes.

**Import style is inconsistent across the repository**, which is the part most likely to be "tidied" by someone who has not read this. Adding `.js` to a relative import in `apps/web` breaks the build; removing it anywhere else breaks the runtime.

`vitest` needs its own override for this app on top: the web project sets `esbuild: { jsx: 'automatic' }` because esbuild cannot emit the `preserve` that Next requires.

The compatibility gate the handoff mandates before Next work remains right, and its lesson is sharper: **a probe only proves what it exercises.** Importing the framework is part of using the framework.

## Alternatives considered

**Keep NodeNext and import `next/link.js`.** Resolves, and is wrong in every other way: it contradicts Next's own documentation and codemods, breaks on any subpath Next does not ship as a real file, and would confuse anyone who has written a Next app before.

**Keep NodeNext and avoid Next's imports entirely** — plain `<a>` instead of `Link`, and so on. Loses client-side navigation and prefetching, and would have to be abandoned the moment a real page needed `next/image` or `next/navigation`. Fighting the framework to preserve a compiler setting that describes something untrue.

**Change the workspace base to `bundler`.** Would make `apps/web` unexceptional and break everything else: the packages and the worker are loaded by Node, and `bundler` resolution would stop catching exactly the class of unloadable-package bug ADR 0010 exists to prevent.

**`moduleResolution: node10`.** Deprecated in TypeScript 6 and slated for removal in 7. Not a candidate.

## What would change this

If Next ships an `exports` map with proper `types` conditions, NodeNext becomes viable and the extension inconsistency could be removed. Worth re-testing at each Next major — the check is one line: add `import Link from 'next/link'` to a page and run `tsc --noEmit` with the base's resolution.

If a future framework choice makes `apps/web` Node-loaded — a plain Fastify-rendered app, say — this ADR stops applying entirely.
