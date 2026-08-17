#!/usr/bin/env node
/**
 * Enforces the project invariants in CLAUDE.md that no off-the-shelf linter
 * knows about.
 *
 * ESLint covers general correctness and the banned `Date` global. These rules
 * are specific to this codebase: they encode decisions recorded in `adr/`, and
 * each one exists because breaking it produces a bug that is silent rather than
 * loud — a ledger that stops balancing, a password in a log aggregator, a
 * config value that cannot be changed without a deploy.
 *
 * Deliberately text-based rather than AST-based. It runs in milliseconds on a
 * pre-commit hook, and a slow hook is a bypassed hook. The cost is occasional
 * false positives, so every rule supports an inline waiver:
 *
 *   // invariant-ok: <rule-id> — <why>
 *
 * The reason is required. A bare waiver is itself a failure, because an
 * unexplained exemption is indistinguishable from someone silencing the check.
 *
 * Usage:
 *   node scripts/check-invariants.mjs            all tracked files
 *   node scripts/check-invariants.mjs --staged   staged files only (hook)
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WAIVER = /invariant-ok:\s*([\w-]+)\s*[—-]\s*\S+/;

/**
 * Which module owns each table, for `no-cross-module-database-writes`.
 *
 * **A module here is a directory under `apps/api/src/`**, which is how BRD §5.1's
 * module list is expressed in this codebase. The rule is CLAUDE.md's: "no direct
 * cross-module database writes — modules talk through application services,
 * interfaces or domain events". Reads are deliberately not policed, because ADR
 * 0044 sanctions exactly one cross-module read and reasons about it at length;
 * a write is the thing that has no sanctioned instance.
 *
 * **`null` means no module owns it**, and the schema says so in as many words
 * about `seller_tax_profiles`: BRD §5.1 names no owner and it has no behaviour
 * to place. Any write to one of those is a violation from everywhere, which is
 * the same answer `seller-tax-profile-is-inactive` gives by a different route.
 *
 * **Adding a Prisma model means adding it here**, and the rule will not see it
 * until you do — the pattern is built from these keys. That is the honest cost
 * of a text-based checker; the alternative is parsing the schema on a pre-commit
 * hook.
 */
const TABLE_OWNERS = {
  user: 'identity',
  webhookEvent: 'identity',
  adminApproval: 'identity',
  authenticationEvent: 'identity',
  profile: 'profiles',
  address: 'profiles',
  auditLog: 'audit',
  category: 'catalogue',
  categoryVersion: 'catalogue',
  listing: 'catalogue',
  listingLocation: 'catalogue',
  booking: 'booking',
  availabilityBlock: 'booking',
  quote: 'booking',
  featureFlagOverride: 'feature-flags',
  sellerTaxProfile: null,
};

/** Prisma's write verbs. `findMany` and friends are not here on purpose. */
const PRISMA_WRITES = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
];

/**
 * Provider SDKs, and the only files allowed to import each one.
 *
 * CLAUDE.md: "every external provider gets an interface, a production adapter, a
 * test fake, and an explicit timeout/error strategy. **Never import a provider
 * SDK outside its adapter.**" Nothing checked it, and the reason it matters is
 * not tidiness — it is that an SDK reachable from the module graph is an SDK
 * whose network calls, retries and timeouts are decided by its defaults in a
 * place where no test can see them.
 *
 * **The allowed path is usually the composition root rather than an adapter**,
 * and that is this project's shape rather than a loophole: `main.ts` constructs
 * `verifyToken` and the Redis client and hands them to classes that take narrow
 * interfaces, which is why `@clerk/backend` and `ioredis` each appear once in
 * the whole API. `prom-client` is the strict form — one adapter behind a
 * domain-shaped port, which CLAUDE.md calls out by name.
 *
 * **`apps/web` is deliberately out of scope**, and it is the one place this rule
 * would produce noise rather than signal. `@clerk/nextjs` is a framework
 * integration, not a provider adapter: it is a provider, a middleware and a
 * component in every page that renders a sign-in control, and ADR 0015 records
 * that the web app is the half of the system holding Clerk's secrets because its
 * SDK requires it. Naming every file that renders a Clerk widget would be a
 * list, not a rule.
 */
const PROVIDER_SDKS = [
  { specifier: '@clerk/backend', adapters: ['apps/api/src/main.ts'] },
  { specifier: 'ioredis', adapters: ['apps/api/src/main.ts'] },
  { specifier: 'bullmq', adapters: ['apps/worker/src/worker.ts'] },
  { specifier: 'prom-client', adapters: ['packages/observability/src/metrics.ts'] },
  { specifier: '@prisma/adapter-pg', adapters: ['packages/database/src/client.ts'] },
  { specifier: '@prisma/client', adapters: ['packages/database/src/client.ts'] },
];

/** The module a file belongs to, or null for anything outside `apps/api/src`. */
function apiModuleOf(path) {
  return path.match(/^apps\/api\/src\/([\w-]+)\//)?.[1] ?? null;
}

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} message
 * @property {string} why
 * @property {(path: string) => boolean} [exempt]
 * @property {(contents: string) => boolean} [scope]
 * @property {(match: RegExpExecArray, path: string) => boolean} [allowed]
 *
 * `exempt` decides from the path alone and is what keeps this checker fast.
 * `scope` reads the file, and exists for the one rule whose subject is a
 * *directive* rather than a location: scoping by filename meant a `'use server'`
 * file named anything else was never checked, which is a rule that enforces a
 * naming convention while claiming to enforce a Next.js constraint.
 *
 * `allowed` decides from **what the pattern matched** as well as where. The
 * first six rules ban a construct outright, so a path is enough to exempt one.
 * The two boundary rules ban a *pairing* — this table written from that module,
 * this SDK imported into that file — and a rule that could only answer from the
 * path would have to be one rule per module, which is a list nobody keeps up to
 * date. It is consulted per match rather than per file, so one legitimate write
 * on a line does not excuse an illegitimate one.
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: 'no-tofixed',
    pattern: /\.toFixed\s*\(/,
    message: 'toFixed() on a numeric value',
    why: 'Money is integer pence (ADR 0002). toFixed is how a float creeps into a total. Use Money.toMajorString or Money.format.',
    exempt: (p) => p.includes('packages/core/src/money'),
  },
  {
    id: 'no-parsefloat',
    pattern: /\bparseFloat\s*\(|\bNumber\.parseFloat\s*\(/,
    message: 'parseFloat()',
    why: 'Parsing money as a float loses precision before validation can catch it (ADR 0002). Use Money.fromMajor, which takes a string.',
  },
  {
    id: 'no-direct-env',
    /*
     * **The object, not only a property read off it.** This was
     * `process\.env\s*[.[]`, which required a `.` or a `[` to follow — so
     * `const { DATABASE_URL } = process.env` and `const e = process.env` were
     * both invisible, and destructuring is the more idiomatic of the two. A
     * word boundary catches every way of getting hold of it while still not
     * matching `process.environment`.
     */
    pattern: /process\.env\b/,
    message: 'direct process.env access',
    why: 'Environment access goes through @platform/config so it is validated once at startup and connection strings are composed rather than read (ADR 0006).',
    /*
     * **The files that are allowed to read it, named.** The exemption was
     * `p.includes('.config.')`, which exempted any path anywhere containing
     * that substring — application code included, since nothing stops a file
     * being called `fee.config.ts`. Only one config file in the tree actually
     * reads the environment, and it is Prisma's, which a CLI loads outside our
     * process before `loadEnv` could have run.
     *
     * `packages/config/src/*env.ts` rather than `.../env`: the schema is four
     * modules now — the base one plus web, identity and personal-data — and
     * three of them take `process.env` as a default parameter, which the old
     * pattern happened not to match. Widening the exemption alongside the
     * pattern keeps the rule's meaning ("only @platform/config reads the
     * environment") rather than its previous accident.
     */
    exempt: (p) =>
      /^packages\/config\/src\/[\w-]*env\.ts$/.test(p) ||
      p.startsWith('scripts/') ||
      p === 'packages/database/prisma.config.ts',
  },
  {
    id: 'no-console',
    pattern: /\bconsole\.(log|info|warn|error|debug)\s*\(/,
    message: 'console.* call',
    why: 'console bypasses redaction, so a password or a listing coordinate reaches the log unredacted (ADR 0007, BRD §8.4.1). Use the logger from @platform/observability.',
    exempt: (p) =>
      p.startsWith('scripts/') || p.includes('packages/observability/src/logger'),
  },
  {
    id: 'no-raw-sql-outside-search',
    pattern: /\$queryRaw|\$executeRaw|\bsql`/,
    message: 'raw SQL',
    why: 'Raw SQL is confined to the Search & Location module behind a repository interface, because Prisma cannot express PostGIS queries (ADR 0004, BRD §4.2). Elsewhere it bypasses the ORM and the module boundary.',
    /*
     * **The module directory, not the word.** This read `p.includes('search')`
     * until slice 3.1a, which exempted any file anywhere in the tree with
     * "search" in its name — `user-search.service.ts`, `search-form.tsx`, a
     * `listing-search.repository.ts` sitting in Catalogue. It cost nothing while
     * no raw SQL existed anywhere; it was tightened the moment the project's
     * first `$queryRaw` went in behind it (ADR 0044).
     *
     * Tests need no exemption — `tracked` drops every `*.test.ts` before any
     * rule runs.
     */
    exempt: (p) =>
      p.includes('apps/api/src/search-location/') || p.startsWith('scripts/'),
  },
  {
    id: 'use-server-exports-only-functions',
    pattern: /^export (const|let|var) (?!\w+\s*(:[^=]+)?=\s*async)/,
    message: 'a non-function export from a "use server" file',
    why: "Next turns every export of a `'use server'` file into a server action, and an exported object makes the route's generated action loader throw \"A 'use server' file can only export async functions, found object\". **It throws when the action is invoked, not when the page renders**, so the form looks perfect until somebody presses the button — which is how this was found, after it had been merged in six files. Put the state type and its initial value in a sibling `state.ts`.",
    /*
     * **The directive, not the filename.** This was
     * `exempt: (p) => !/app\/.*actions\.ts$/.test(p)`, which is a rule about
     * where server actions have been put rather than about what makes an export
     * a server action. Every `'use server'` file in the tree happens to be named
     * `actions.ts` today; the next one to be named anything else — `mutations.ts`,
     * `submit.ts`, a route handler — would have been unchecked, and the failure
     * mode is the reason the rule exists: it throws when the button is pressed,
     * not when the page renders.
     *
     * Reading the file costs nothing measurable here — `tracked` has already
     * read it for the line scan — so the "keeps the checker fast" argument the
     * old comment made was never paying for anything.
     *
     * Deliberately conservative about *where* the directive appears: a
     * function-level `'use server'` also brings the file into scope, which can
     * only over-report. Over-reporting is waivable on the line; under-reporting
     * shipped in six files once already.
     */
    scope: (contents) => /^\s*(['"])use server\1\s*;?\s*$/m.test(contents),
  },
  {
    id: 'seller-tax-profile-is-inactive',
    /*
     * **Both cases and both numbers.** `\bsellerTaxProfile\b` is the Prisma
     * client accessor and nothing else: it missed `SellerTaxProfile`, which is
     * how the type is imported, and `sellerTaxProfiles`, which is how a relation
     * or a `findMany` result is named. Any of the three would be application
     * code reaching an entity that must stay empty.
     *
     * Not the snake-case table name: `seller_tax_profiles` appears in prose
     * across the contracts package and the migrations, explaining what this
     * table is *not*, and a rule that fires on documentation of itself gets
     * waived everywhere and then means nothing.
     */
    pattern: /\b[sS]ellerTaxProfiles?\b/,
    message: 'application code reading or writing the seller tax profile',
    why: 'BRD §8.14.2 requires this entity to exist but stay inactive while every category is flagged `none`, so activating reporting is a configuration switch rather than a rebuild. Nothing should reach it yet. When it does activate, it becomes the fourth table holding personal data — and nothing enumerates those, so it must arrive together with `PersonalDataEraser` and both `PersonalDataSource` projections, or it will be silently missing from account deletion and from the data export.',
  },
  {
    id: 'no-cross-module-database-writes',
    /*
     * `<something>.<table>.<writeVerb>(` — built from the two lists above so the
     * rule and the ownership map cannot drift apart. Two segments are required,
     * which is what keeps `statuses.delete(id)` and every other Map out of it:
     * a Prisma write always reads `client.model.verb(`.
     */
    pattern: new RegExp(
      `\\.(${Object.keys(TABLE_OWNERS).join('|')})\\.(${PRISMA_WRITES.join('|')})\\s*\\(`,
    ),
    message: 'a write to a table another module owns',
    why: "BRD §5.1 and CLAUDE.md: modules talk through application services, interfaces or domain events, never through each other's tables. A direct write is invisible to the owning module's invariants, its audit entries and its erasure — the row changes and the module responsible for what that row means never hears about it. The port the consumer already declares is where this belongs; there are six of them across this boundary already.",
    /*
     * Only the API has modules. `packages/database` owns the schema, `scripts/`
     * seeds and measures, and the worker has no database client at all.
     */
    exempt: (p) => !p.startsWith('apps/api/src/'),
    allowed: (match, path) => TABLE_OWNERS[match[1]] === apiModuleOf(path),
  },
  {
    id: 'no-provider-sdk-outside-adapter',
    /*
     * Both spellings, because one of them is how a lazy import arrives:
     * `from 'ioredis'` and `require('ioredis')`. A dynamic
     * `await import('ioredis')` matches the second half too, since the quoted
     * specifier is what is being looked for rather than the keyword in front of
     * it.
     */
    pattern: new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*['"](${PROVIDER_SDKS.map((sdk) =>
        // No specifier contains a regex metacharacter today. Escaped anyway, so
        // that adding one with a `.` in it is not a silently wider rule.
        sdk.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ).join('|')})(?:/[\\w./-]+)?['"]`,
    ),
    message: 'a provider SDK imported outside its adapter',
    why: 'CLAUDE.md: every external provider gets an interface, a production adapter, a test fake and an explicit timeout/error strategy — and the SDK is never imported outside that adapter. An import anywhere else takes the provider’s defaults for timeouts, retries and error shape into code no test can substitute, and it puts a third party in the module graph of something that was meant to depend on an interface. If a second file genuinely needs one, that is a decision: add it to PROVIDER_SDKS in this file, where the next person can see who reaches what.',
    /*
     * Server code only. `apps/web` is excluded in the list above and the reason
     * is written there; `scripts/` drives Docker and pnpm rather than providers.
     */
    exempt: (p) =>
      !(
        p.startsWith('apps/api/src/') ||
        p.startsWith('apps/worker/src/') ||
        /^packages\/[\w-]+\/src\//.test(p)
      ),
    allowed: (match, path) =>
      PROVIDER_SDKS.some(
        (sdk) => sdk.specifier === match[1] && sdk.adapters.includes(path),
      ),
  },
  {
    id: 'no-hardcoded-money',
    pattern: /\b(fee|price|amount|deposit|total|charge)\w*\s*[:=]\s*\d+\.\d+/i,
    message: 'decimal literal assigned to a money-shaped name',
    why: 'Money is integer pence and fee rates are versioned configuration, never literals (ADR 0002, BRD §8.2).',
  },
];

/**
 * This file necessarily contains every pattern it detects — the rule
 * definitions quote the very constructs they ban. Scanning itself produces
 * guaranteed false positives, so it is excluded by construction rather than
 * by a waiver on each rule.
 */
const SELF = 'scripts/check-invariants.mjs';

function tracked(stagedOnly) {
  const command = stagedOnly
    ? 'git diff --cached --name-only --diff-filter=ACM'
    : 'git ls-files';
  return execSync(command, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path))
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
    .filter((path) => path.replace(/\\/g, '/') !== SELF);
}

function stripNoise(line) {
  // Crude, and enough: avoids flagging a rule's own description or a comment
  // explaining why something is banned.
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

const stagedOnly = process.argv.includes('--staged');
const files = tracked(stagedOnly);

/** @type {{file: string, line: number, rule: Rule, text: string}[]} */
const violations = [];

for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue; // Deleted between listing and reading.
  }

  const lines = contents.split('\n');

  for (const rule of RULES) {
    if (rule.exempt?.(file.replace(/\\/g, '/'))) continue;
    // A rule may also decide from the file's own contents — see the Rule
    // typedef. Checked after `exempt` so a path-based skip still costs nothing.
    if (rule.scope !== undefined && !rule.scope(contents)) continue;

    lines.forEach((raw, index) => {
      const code = stripNoise(raw);
      const match = code.match(rule.pattern);
      if (match === null) return;
      // What was matched, not only where — see the Rule typedef. The two
      // boundary rules ban a pairing rather than a construct, so the path alone
      // cannot answer them.
      if (rule.allowed?.(match, file.replace(/\\/g, '/'))) return;

      const waiver = WAIVER.exec(raw) ?? WAIVER.exec(lines[index - 1] ?? '');
      if (waiver && waiver[1] === rule.id) return;

      violations.push({ file, line: index + 1, rule, text: raw.trim() });
    });
  }
}

if (violations.length === 0) {
  console.log(`Invariants: ${files.length} file(s) checked, no violations.`);
  process.exit(0);
}

console.error(`\nInvariant violations (${violations.length}):\n`);

const byRule = new Map();
for (const violation of violations) {
  const list = byRule.get(violation.rule.id) ?? [];
  list.push(violation);
  byRule.set(violation.rule.id, list);
}

for (const [ruleId, list] of byRule) {
  const { why, message } = list[0].rule;
  console.error(`  ${ruleId} — ${message}`);
  console.error(`  ${why}\n`);
  for (const violation of list) {
    console.error(`    ${violation.file}:${violation.line}`);
    console.error(`      ${violation.text}`);
  }
  console.error('');
}

console.error(
  `If a violation is genuinely correct, waive it on the line or the one above:\n` +
    `  // invariant-ok: <rule-id> — <reason>\n` +
    `The reason is required; an unexplained waiver is indistinguishable from\n` +
    `silencing the check.\n`,
);

process.exit(1);
