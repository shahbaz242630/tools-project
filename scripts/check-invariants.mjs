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
 * @typedef {Object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} message
 * @property {string} why
 * @property {(path: string) => boolean} [exempt]
 * @property {(contents: string) => boolean} [scope]
 *
 * `exempt` decides from the path alone and is what keeps this checker fast.
 * `scope` reads the file, and exists for the one rule whose subject is a
 * *directive* rather than a location: scoping by filename meant a `'use server'`
 * file named anything else was never checked, which is a rule that enforces a
 * naming convention while claiming to enforce a Next.js constraint.
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
      if (!rule.pattern.test(code)) return;

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
