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
    pattern: /process\.env\s*[.[]/,
    message: 'direct process.env access',
    why: 'Environment access goes through @platform/config so it is validated once at startup and connection strings are composed rather than read (ADR 0006).',
    exempt: (p) =>
      p.includes('packages/config/src/env') ||
      p.startsWith('scripts/') ||
      p.includes('.config.'),
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
    exempt: (p) => p.includes('search') || p.startsWith('scripts/'),
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
