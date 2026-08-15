#!/usr/bin/env node
/**
 * Fails when a dependency carries a licence incompatible with shipping a
 * commercial closed-source product.
 *
 * Copyleft licences are not "bad" — they are simply unusable here, because
 * distributing a linked work would oblige us to publish source we intend to
 * keep private once the repository goes private before launch.
 *
 * Run via `pnpm licences:check`.
 *
 * **This used to be exact-string set membership, and it let two things through
 * that it was written to catch.** `@img/sharp-win32-x64` declares
 * `Apache-2.0 AND LGPL-3.0-or-later`, which matched neither the deny set nor the
 * review set — the deny set held `LGPL-3.0`, the modern SPDX identifier carries
 * an `-or-later` suffix, and the whole string is a compound expression rather
 * than an identifier at all. It was printed under "licences in use" and
 * classified as nothing. Meanwhile `EPL-2.0: elkjs` printed `NEEDS REVIEW` and
 * the process exited 0, which is not a gate; it is a log line.
 *
 * So three things happen here now, and all three are unit tested:
 *
 * 1. **Identifiers are normalised.** `LGPL-3.0-only`, `LGPL-3.0-or-later` and
 *    the deprecated `LGPL-3.0+` are all the LGPL-3.0 policy question.
 * 2. **Expressions are parsed, not matched.** `AND` takes the stricter of its
 *    operands, `OR` takes the more permissive because we may choose which to
 *    comply with, and parentheses group. `WITH` binds to the identifier and is
 *    judged on the licence rather than the exception, which is the conservative
 *    reading. pnpm also emits a lowercase `MIT and ISC`, so the operators are
 *    matched case-insensitively.
 * 3. **"Needs review" fails the build**, unless the exact package and licence
 *    are recorded in AUDIT-EXCEPTIONS.md and repeated in REVIEWED below. That
 *    file is the existing precedent for a documented, scoped exception with a
 *    void condition, and the two entries here follow it.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Licences that would force us to publish our own source. */
export const DENIED = new Set([
  'GPL-1.0',
  'GPL-2.0',
  'GPL-3.0',
  'AGPL-1.0',
  'AGPL-3.0',
  'SSPL-1.0',
  'CC-BY-NC-4.0',
  'BUSL-1.1',
]);

/**
 * Licences that need a human decision rather than an automatic pass or fail —
 * weak copyleft is usually fine when merely linked, but not always.
 */
export const REVIEW = new Set([
  'LGPL-2.1',
  'LGPL-3.0',
  'MPL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'CDDL-1.0',
  'CDDL-1.1',
]);

/**
 * Licences that impose no source-publication obligation on us.
 *
 * Listed so that an identifier nobody has classified is *visible* rather than
 * silently permitted. It is still permitted — see `classifyIdentifier` — because
 * failing on every unfamiliar permissive licence would redden the build for
 * `BlueOak-1.0.0` and teach everyone to ignore this check. The copyleft families
 * below are what stops that leniency from being a hole.
 */
export const PERMISSIVE = new Set([
  '0BSD',
  'AFL-2.1',
  'Apache-1.1',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-Source-Code',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MS-PL',
  'PostgreSQL',
  'Python-2.0',
  'Ruby',
  'UPL-1.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'W3C',
  'WTFPL',
  'Zlib',
]);

/**
 * Prefixes of licence families that always need a decision, whatever version
 * appears.
 *
 * The safety net under the two sets above: a dependency arriving on
 * `MPL-2.0-no-copyleft-exception`, `EUPL-1.2` or `LGPL-2.0` is in no list and
 * must not therefore be waved through. Ordered so `AGPL-` is answered before
 * `GPL-` could be consulted at all.
 */
const FAMILIES = [
  { prefix: 'AGPL-', verdict: 'denied' },
  { prefix: 'SSPL-', verdict: 'denied' },
  { prefix: 'BUSL-', verdict: 'denied' },
  { prefix: 'CC-BY-NC', verdict: 'denied' },
  { prefix: 'LGPL-', verdict: 'review' },
  { prefix: 'GPL-', verdict: 'denied' },
  { prefix: 'MPL-', verdict: 'review' },
  { prefix: 'EPL-', verdict: 'review' },
  { prefix: 'CDDL-', verdict: 'review' },
  { prefix: 'EUPL-', verdict: 'review' },
  { prefix: 'OSL-', verdict: 'review' },
  { prefix: 'CPAL-', verdict: 'review' },
  { prefix: 'RPL-', verdict: 'review' },
];

/**
 * Reviewed and accepted, with the reasoning in AUDIT-EXCEPTIONS.md.
 *
 * **Matched by pattern rather than by exact name, deliberately.** Both entries
 * are native binaries whose package name carries the platform:
 * `@img/sharp-win32-x64` on the maintainer's machine, `@img/sharp-linux-x64` and
 * `@img/sharp-libvips-linux-x64` on the CI runner and in the deployed image. An
 * exact name would have passed here and reddened CI on its first run, which is
 * this project's recurring lesson wearing new clothes: a probe only proves what
 * it exercises, and this one runs on a different platform from where it matters.
 */
export const REVIEWED = [
  {
    packages: /^@img\/sharp(-libvips)?-/,
    licence: 'LGPL-3.0',
    why: 'libvips, dynamically linked, unmodified, and never distributed — we run a hosted service. AUDIT-EXCEPTIONS.md',
  },
  {
    packages: /^elkjs$/,
    licence: 'EPL-2.0',
    why: 'Prisma Studio only, unmodified, never distributed, never loaded by a deployed process. AUDIT-EXCEPTIONS.md',
  },
];

/**
 * Strip the version-scope suffix an SPDX identifier may carry.
 *
 * `-only` and `-or-later` say which *versions* of a licence apply. They change
 * nothing about whether we may use it, so they are removed before the policy
 * question is asked — otherwise the deny list has to carry three spellings of
 * every entry and will carry two of them.
 */
export function normaliseLicenceId(identifier) {
  return String(identifier)
    .trim()
    .replace(/\+$/, '')
    .replace(/-(only|or-later)$/i, '');
}

const SEVERITY = { allowed: 0, review: 1, denied: 2 };

/**
 * One identifier's verdict, plus whether anybody has ever classified it.
 *
 * An unrecognised identifier is permitted and reported. See PERMISSIVE.
 */
export function classifyIdentifier(identifier) {
  const id = normaliseLicenceId(identifier);

  if (DENIED.has(id)) return { verdict: 'denied', id, known: true };
  if (REVIEW.has(id)) return { verdict: 'review', id, known: true };
  if (PERMISSIVE.has(id)) return { verdict: 'allowed', id, known: true };

  const family = FAMILIES.find((entry) => id.toUpperCase().startsWith(entry.prefix));
  if (family !== undefined) return { verdict: family.verdict, id, known: true };

  return { verdict: 'allowed', id, known: false };
}

/**
 * Split an SPDX expression into tokens.
 *
 * Parentheses are separated from their neighbours so `(MIT OR GPL-3.0)` does not
 * produce an identifier called `(MIT`.
 */
function tokenise(expression) {
  return String(expression)
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
}

const isOperator = (token, word) => token.toUpperCase() === word;

/**
 * Evaluate an SPDX licence expression.
 *
 * Recursive descent over `expr := term (OR term)*`, `term := factor (AND
 * factor)*`, `factor := '(' expr ')' | id ('WITH' id)?` — which is SPDX's own
 * precedence: AND binds tighter than OR.
 *
 * The interesting half is how the two operators combine, and they are not
 * symmetric. **AND takes the stricter operand**, because a work offered under
 * both licences obliges us under both. **OR takes the more permissive**, because
 * a work offered under either lets us choose — and choosing is free, so a
 * `MIT OR GPL-3.0` dependency is an MIT dependency for our purposes and its GPL
 * half must not be reported as a problem we have.
 *
 * Returns the verdict and only the identifiers that *drove* it, so an OR branch
 * we did not take contributes nothing to the report.
 */
export function evaluateExpression(expression) {
  const tokens = tokenise(expression);
  let position = 0;

  const peek = () => tokens[position];

  function parseFactor() {
    const token = tokens[position];

    if (token === '(') {
      position += 1;
      const inner = parseExpression();
      // A missing `)` is a malformed expression rather than a licence question.
      // Consuming it when present and ignoring its absence keeps this a
      // classifier rather than a parser with its own error vocabulary.
      if (peek() === ')') position += 1;
      return inner;
    }

    position += 1;
    const { verdict, id, known } = classifyIdentifier(token ?? '');

    // `GPL-2.0 WITH Classpath-exception-2.0` — the exception can only widen what
    // the licence permits, and reading it is a human's job. Judge the licence,
    // name the whole expression in the report.
    if (peek() !== undefined && isOperator(peek(), 'WITH')) {
      position += 2;
    }

    return {
      verdict,
      identifiers: verdict === 'allowed' ? [] : [id],
      unrecognised: known ? [] : [id],
    };
  }

  function parseTerm() {
    let left = parseFactor();

    while (peek() !== undefined && isOperator(peek(), 'AND')) {
      position += 1;
      const right = parseFactor();
      left = {
        verdict:
          SEVERITY[right.verdict] > SEVERITY[left.verdict]
            ? right.verdict
            : left.verdict,
        identifiers: [...left.identifiers, ...right.identifiers],
        unrecognised: [...left.unrecognised, ...right.unrecognised],
      };
    }

    return left;
  }

  function parseExpression() {
    let left = parseTerm();

    while (peek() !== undefined && isOperator(peek(), 'OR')) {
      position += 1;
      const right = parseTerm();
      // The branch we would take, and only its identifiers.
      left = SEVERITY[right.verdict] < SEVERITY[left.verdict] ? right : left;
    }

    return left;
  }

  const result = parseExpression();

  return {
    verdict: result.verdict,
    // Deduplicated: `LGPL-3.0-only AND LGPL-3.0-or-later` is one question.
    identifiers: [...new Set(result.identifiers)],
    unrecognised: [...new Set(result.unrecognised)],
  };
}

/** The recorded exception covering this package and licence, if there is one. */
export function findException(packageName, identifier) {
  const id = normaliseLicenceId(identifier);
  return (
    REVIEWED.find(
      (entry) =>
        entry.packages.test(packageName) && normaliseLicenceId(entry.licence) === id,
    ) ?? null
  );
}

/**
 * Turn `pnpm licenses list --json` into a verdict per package.
 *
 * Pure, so the interesting cases — a compound expression, an exception that
 * covers one identifier of two, a package whose name only matches on another
 * platform — are testable without an install.
 */
export function assess(licences) {
  const blocked = [];
  const needsReview = [];
  const excused = [];
  const unrecognised = new Set();

  for (const [expression, packages] of Object.entries(licences)) {
    const result = evaluateExpression(expression);
    for (const id of result.unrecognised) unrecognised.add(id);

    const names = (Array.isArray(packages) ? packages : []).map(
      (entry) => entry.name ?? String(entry),
    );

    if (result.verdict === 'allowed') continue;

    for (const name of names) {
      if (result.verdict === 'denied') {
        blocked.push({ name, expression, identifiers: result.identifiers });
        continue;
      }

      // Every reviewable identifier in the expression needs its own recorded
      // decision. Covering one of two is not covering it.
      const exceptions = result.identifiers.map((id) => findException(name, id));

      if (exceptions.every((entry) => entry !== null)) {
        excused.push({ name, expression, why: exceptions[0]?.why ?? '' });
      } else {
        needsReview.push({ name, expression, identifiers: result.identifiers });
      }
    }
  }

  return { blocked, needsReview, excused, unrecognised: [...unrecognised].sort() };
}

function readLicences() {
  // Fixed command with no interpolated input, so a shell is safe here. pnpm is
  // a .cmd shim on Windows and cannot be invoked without one.
  const raw = execSync('pnpm licenses list --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

function main() {
  let licences;
  try {
    licences = readLicences();
  } catch (error) {
    console.error('Could not read dependency licences:', String(error).split('\n')[0]);
    return 1;
  }

  const { blocked, needsReview, excused, unrecognised } = assess(licences);

  console.log(`Licences in use: ${Object.keys(licences).sort().join(', ')}\n`);

  if (unrecognised.length > 0) {
    // Not a failure. Visible, so that adding it to PERMISSIVE or REVIEW is a
    // decision somebody makes rather than one the absence of a list makes.
    console.log(`UNCLASSIFIED  ${unrecognised.join(', ')}`);
    console.log('              In no policy list; treated as permissive.\n');
  }

  for (const { name, expression, why } of excused) {
    console.log(`REVIEWED      ${expression}: ${name}`);
    console.log(`              ${why}`);
  }

  for (const { name, expression, identifiers } of needsReview) {
    console.log(`NEEDS REVIEW  ${expression}: ${name}  (${identifiers.join(', ')})`);
  }

  for (const { name, expression, identifiers } of blocked) {
    console.log(`BLOCKED       ${expression}: ${name}  (${identifiers.join(', ')})`);
  }

  if (blocked.length > 0) {
    console.error(
      `\n${blocked.length} blocked licence(s) present. These would oblige us to ` +
        `publish our own source. Remove the dependency or find an alternative.`,
    );
    return 1;
  }

  if (needsReview.length > 0) {
    console.error(
      `\n${needsReview.length} licence(s) need a human decision and none is ` +
        `recorded.\nWeak copyleft is usually fine when merely linked and ` +
        `unmodified, but that is a judgement somebody has to make and write ` +
        `down.\nDecide, then add an entry to AUDIT-EXCEPTIONS.md and to ` +
        `REVIEWED in this file — or remove the dependency.`,
    );
    return 1;
  }

  console.log(
    excused.length > 0
      ? `\nNo blocked licences. ${excused.length} reviewed and recorded.\n`
      : '\nNo blocked licences.\n',
  );
  return 0;
}

// Importable for its tests, executable as a command. `process.argv[1]` under
// vitest is the runner, so this stays false there and importing the module
// starts no `pnpm` subprocess.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main();
}
