# Dependency audit exceptions

Every entry in `pnpm.auditConfig.ignoreGhsas` must be justified here, with a
review trigger. An unexplained ignore is indistinguishable from negligence, and
this list is the first thing to check when a security review asks why `pnpm
audit` is green.

Review the whole file whenever a major dev-tooling dependency is upgraded.

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
