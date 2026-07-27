# 0011. Build the API as CommonJS inside an ESM workspace

- **Status:** Accepted
- **Date:** 2026-07-27
- **Relates to:** BRD §4, §5

## Context

The workspace is ESM: the root package is `"type": "module"` and `tsconfig.base.json` sets `module: NodeNext` with `verbatimModuleSyntax`.

BRD §4 nominates NestJS with the Fastify adapter. NestJS resolves constructor dependencies from `design:paramtypes` metadata, emitted by TypeScript's legacy `experimentalDecorators` and `emitDecoratorMetadata`. That path is well-trodden on CommonJS. On ESM it is not: NestJS supports it, but the supported combination is narrower and the failures are obscure.

Three findings from testing the combination before committing to it, rather than after:

1. **`verbatimModuleSyntax` is incompatible with CommonJS emit.** TypeScript rejects ESM import syntax in a CommonJS file outright (TS1295).
2. **`module: Node16` does not work at all here.** A CommonJS file importing an ESM package fails with TS1479. Only `NodeNext` models Node's ability to `require()` an ES module, and every `@platform/*` package is ESM. This is the one setting with no workaround.
3. **esbuild silently discards decorator metadata.** Vitest transforms TypeScript with esbuild, which does not implement `emitDecoratorMetadata`. Nest then injects `undefined` for every constructor dependency. Nothing fails to compile; the first symptom is a 500 at request time from a controller whose service is `undefined`.

The third is the dangerous one. It is invisible until a test exercises real dependency injection, and it fails in a way that looks like application logic rather than configuration.

## Decision

`apps/api` is CommonJS. Its `tsconfig.json` overrides the workspace defaults: `verbatimModuleSyntax: false`, `experimentalDecorators` and `emitDecoratorMetadata` on, `module` and `moduleResolution` at `NodeNext`.

Vitest runs `apps/api` as a separate project with `unplugin-swc`, because swc implements decorator metadata. `packages/*` keep the default esbuild transform, which is faster and sufficient for code without decorators.

`engines.node` is raised to `>=22.12.0`, the first release where `require()` of an ES module is available unflagged.

## Consequences

Two module systems in one repository. Anyone adding a file to `apps/api` must not assume the workspace's ESM rules apply, which is why the divergence is commented in the tsconfig rather than left to be discovered.

**No `@platform/*` package may use top-level await.** `require(esm)` fails on an ESM graph that contains it, so a single top-level await anywhere in the dependency tree would break the API at startup. None do today. Nothing enforces this yet, which is a gap worth closing if it ever bites.

Node 22.12 is now a hard floor rather than a preference. An older Node produces a startup failure whose message does not mention module formats.

Two dev dependencies added — `@swc/core` and `unplugin-swc` — for a transform vitest cannot otherwise perform. They duplicate nothing.

## Alternatives considered

**Run NestJS as ESM.** Keeps one module system and matches the rest of the workspace. Rejected on maturity: the decorator and metadata path is materially less exercised on ESM, and the failure modes we would be volunteering for are the same silent-injection ones described above. This is the option to revisit first if the split becomes painful.

**Compile the packages to CommonJS as well, or dual-emit.** Removes `require(esm)` from the picture entirely and lowers the Node floor. Rejected because dual-emit doubles the build output and creates the dual-package hazard, where two copies of a module disagree about instance identity — which would break `AsyncLocalStorage`-based correlation (ADR 0007) in a way that is very hard to see.

**Bundle the API so module format stops mattering.** Legitimate, and likely correct eventually. Rejected now as disproportionate: it adds a bundler to fix a configuration question that three tsconfig lines answer.

**Use Jest for `apps/api`.** Nest's default, and `ts-jest` handles decorator metadata without a plugin. Rejected because it means two test runners, two configurations and two sets of assertions in one repository — a much larger split than one extra vitest project.

## What would change this

NestJS ESM support becoming the documented default path, at which point the CommonJS island stops paying for itself.

Or the arrival of a second app with different needs: if `apps/worker` also wants CommonJS the split is settled, and if it does not, the inconsistency is worth revisiting as a whole rather than per-app.
