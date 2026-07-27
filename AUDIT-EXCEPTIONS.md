# Dependency audit exceptions

Every entry in `pnpm.auditConfig.ignoreGhsas` must be justified here, with a
review trigger. An unexplained ignore is indistinguishable from negligence, and
this list is the first thing to check when a security review asks why `pnpm
audit` is green.

Review the whole file whenever a major dev-tooling dependency is upgraded.

Entries in `pnpm.overrides` are recorded at the bottom. Those are fixes rather
than exceptions, but a reviewer finding a pinned transitive dependency deserves
to know why it is pinned and when the pin can go.

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
