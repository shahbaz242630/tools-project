# Dependency audit exceptions

Every entry in `pnpm.auditConfig.ignoreGhsas` must be justified here, with a
review trigger. An unexplained ignore is indistinguishable from negligence, and
this list is the first thing to check when a security review asks why `pnpm
audit` is green.

Review the whole file whenever a major dev-tooling dependency is upgraded.

Entries in `pnpm.overrides` are recorded at the bottom. Those are fixes rather
than exceptions, but a reviewer finding a pinned transitive dependency deserves
to know why it is pinned and when the pin can go.

**Reviewed licences are recorded in the middle section**, and follow the same
rule: `scripts/check-licences.mjs` fails on a weak-copyleft dependency unless it
is written down here _and_ repeated in that file's `REVIEWED` list. Two homes for
one decision is normally a smell; here it is the point, because the list in the
script is what the build reads and this file is what a human reads, and a
mismatch between them is a decision somebody made without recording it.

---

## GHSA-mh99-v99m-4gvg — `brace-expansion` ReDoS

|                         |                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Added                   | 2026-07-26                                                                              |
| Severity                | High                                                                                    |
| Advisory range          | vulnerable `<=5.0.7`, patched `>=5.0.8`                                                 |
| Versions present        | 1.1.16, 2.1.2 (5.0.8 also present and already patched)                                  |
| Reachable in production | **No**                                                                                  |
| Review trigger          | Any eslint or vitest major upgrade, or when `minimatch` moves off `brace-expansion` 1.x |

**Why it is ignored.**

The advisory declares a single upper bound of `5.0.7`. Semver-wise that sweeps
in the separately-maintained 1.x and 2.x release lines, because `1.1.16` and
`2.1.2` both sort below `5.0.7` — even though those lines are not the same code
as the 5.x line the fix landed in.

The nominated fix cannot be applied to those consumers. `brace-expansion` 5.x
removed its CommonJS default export, and `minimatch@9` calls it as
`brace_expansion_1.default(...)`. Forcing the upgrade was tested and fails:

```
TypeError: (0 , brace_expansion_1.default) is not a function
  at braceExpand (minimatch@9.0.9/dist/commonjs/index.js:160:42)
  at TestExclude.glob (test-exclude@7.0.2/index.js:128:28)
```

So `pnpm overrides` is not a route to compliance here — it trades a
theoretical dev-time ReDoS for a broken coverage pipeline.

**Why the residual risk is acceptable.**

The affected packages reach us only through development tooling — `eslint` and
`@vitest/coverage-v8`. Neither is a runtime dependency of any application
package, so the vulnerable code is never deployed and never processes untrusted
input. A ReDoS requires an attacker-supplied glob pattern; ours are written by
us in configuration files.

**What would change this.**

If `brace-expansion` backports the fix to the 1.x or 2.x lines, remove this
entry and take the patch. If either affected package ever becomes a runtime
dependency, this exception is void and must be re-assessed immediately.

---

# Licences reviewed and accepted

Weak copyleft is usually fine when a dependency is merely linked and unmodified,
and it is never fine by default. `pnpm licences:check` fails on every one of them
until the judgement below exists.

Both entries are matched by **pattern** in `scripts/check-licences.mjs`, because
the package name carries the platform: what resolves on the maintainer's Windows
machine is not what resolves on the ubuntu CI runner or in the deployed
`linux/amd64` image. An exact name would have passed locally and reddened CI.

## `LGPL-3.0-or-later` — `@img/sharp-*`, `@img/sharp-libvips-*`

|                         |                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Added                   | 2026-08-15                                                                                   |
| Kind                    | Weak copyleft (library)                                                                      |
| Declared as             | `Apache-2.0 AND LGPL-3.0-or-later` on the wrapper, `LGPL-3.0-or-later` on the libvips binary |
| Reached through         | `@app/web` → `next` → `sharp` → the platform-specific prebuilt binary                        |
| Reachable in production | **Yes** — Next uses it for image optimisation                                                |
| Review trigger          | Any `sharp` major, or the first time we patch, rebuild or statically link libvips            |

**Why it is accepted.** The LGPL half is libvips, a native library loaded
dynamically by `sharp` at runtime. We do not modify it, do not statically link
it, and — the clause that actually settles it — **we distribute nothing**. The
LGPL's obligations attach to conveying a work; we run a hosted service and the
container image is ours to run, not something a user receives. Section 4's
combined-work conditions are satisfied by dynamic linking in any case, and the
unmodified library remains replaceable in the image.

**What would change this.** Shipping a downloadable artefact containing it, or
modifying libvips, voids this exception immediately and needs a fresh decision.
So does statically linking it, which would make the "replaceable" argument false.

## `EPL-2.0` — `elkjs`

|                         |                                                                          |
| ----------------------- | ------------------------------------------------------------------------ |
| Added                   | 2026-08-15                                                               |
| Kind                    | Weak copyleft (file-level)                                               |
| Reached through         | `@prisma/client` → `prisma` (peer) → `@prisma/studio-core` → `elkjs`     |
| Reachable in production | **No** — a graph-layout library inside Prisma Studio, which we never run |
| Review trigger          | Any Prisma major, or anything that makes Prisma Studio part of a runtime |

**Why it is accepted.** EPL-2.0 is file-level copyleft: the obligation is to
publish modifications _to EPL-licensed files_, not to the program that uses them.
We have never opened one. It arrives only as a transitive dependency of Prisma
Studio, a local development tool — `pnpm deploy --prod` does not carry the
`prisma` CLI into the runtime image, and nothing in `apps/*` imports it.

**What would change this.** Vendoring, patching or forking `elkjs` voids this.
So does anything that puts Prisma Studio in front of a user, which would make it
a distributed component rather than a local tool.

## `UNLICENSED` and friends — no exception, and why there is an entry anyway

|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Added          | 2026-08-15                                                                                         |
| Kind           | **Policy**, not an exception — nothing is excused by it and the list below is empty on purpose     |
| Applies to     | `UNLICENSED`, `Unknown`, an empty licence field, `NOASSERTION`, `SEE LICENSE IN …`, `LicenseRef-…` |
| Verdict        | **Fails the build**, as its own class rather than as copyleft                                      |
| Review trigger | The first time one of these appears and somebody wants it excused                                  |

**What was wrong.** `scripts/check-licences.mjs` deliberately permits an
identifier that appears in none of its policy lists, and prints it as
`UNCLASSIFIED`. That leniency is correct and is defended in the file: failing on
every unfamiliar permissive licence would redden the build for the next
`BlueOak-1.0.0` and teach everyone to skip the check. But it could not tell an
unfamiliar _permissive_ licence from **the absence of a grant**, so a dependency
declaring `UNLICENSED` — npm's way of saying the publisher grants no rights at
all — took the same silent pass as `Zlib`. Found in the August 2026 audit.

**Why that is worse than the copyleft cases above.** GPL tells us exactly what it
would oblige us to do; we decline the price and remove the dependency. `UNLICENSED`
grants nothing, so there is no price and no compliant way to use it: we would be
copying and deploying somebody's code with no permission whatsoever, in a
repository that goes private before launch and ships as a hosted service. A gate
that blocks the licence we could at least reason about while passing the one that
gives us no rights is a gate pointed at the wrong risk.

**What it does now.** Six declarations are recognised as granting nothing and each
fails with its own message naming the remedy. `SEE LICENSE IN …` is matched on the
whole declaration before it is parsed, because it is not an SPDX expression —
tokenising it yields an identifier called `SEE`, which is exactly how it passed.
`MIT OR UNLICENSED` still passes, because OR lets us choose and choosing is free;
`MIT AND UNLICENSED` fails, because AND obliges us under both.

**`Unlicense` is not `UNLICENSED`** and the two differ by one letter while meaning
opposite things — the first is a public-domain dedication. It is in the tree today
(`pnpm licences:check` lists it), so this was a live trap rather than a
hypothetical one. Every pattern is anchored, and a test asserts the pair.

**What would change this.** If we ever buy a commercial licence for a package that
publishes as `UNLICENSED`, that is recordable: add an entry here naming the
agreement and its scope, and the matching entry to `REVIEWED` in
`scripts/check-licences.mjs`. The mechanism is the same one the two licences above
use, and it is deliberately available for this class and **not** for the denied
copyleft ones — a private agreement can change what we are permitted to do with
an unlicensed package; nothing written here changes what the GPL requires.

---

# Overrides applied

## `find-my-way@<9.7.0` → `>=9.7.0` — CVE-2026-47219

|                         |                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Added                   | 2026-07-27                                                                               |
| Severity                | High (CVSS 7.5)                                                                          |
| Advisory range          | vulnerable `<=9.6.0`, patched `>=9.7.0`                                                  |
| Reached through         | `@app/api` → `@nestjs/platform-fastify` → `find-my-way`                                  |
| Reachable in production | **Yes** — it is the router serving every API request                                     |
| Review trigger          | Any `@nestjs/platform-fastify` upgrade; drop the pin once it depends on `>=9.7.0` itself |

`find-my-way` looks up `this.trees[req.method]` on a plain object. Under HTTP/2,
where the method is attacker-controlled and unvalidated, a value like
`constructor` or `__proto__` resolves an inherited property instead of
`undefined`. The router then treats it as a node and crashes on
`currentNode.prefix.length` — a remotely triggerable denial of service.

We do not serve HTTP/2 today, so this is not currently exploitable against us.
That is a reason to be calm, not a reason to ship it: the exposure would appear
silently the moment HTTP/2 is enabled, most likely by a reverse-proxy
configuration change made by someone who has never read this file.

`@nestjs/platform-fastify@11.1.28` pins `find-my-way@9.6.0` exactly, so the fix
has to be forced. 9.7.0 is a patch release on the same line; the full suite,
including the routing and 404 integration tests, passes against it.

Remove the override once NestJS ships a release that depends on `>=9.7.0`.
Leaving it in place after that would silently hold the router back.
