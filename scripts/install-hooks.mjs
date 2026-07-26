#!/usr/bin/env node
/**
 * Installs the git hooks.
 *
 * Written directly into .git/hooks rather than using husky or similar. The
 * hooks are twelve lines of shell; a dependency to manage them would be more
 * code than the thing it manages, and one more supply-chain surface on a
 * repository whose whole point is handling money.
 *
 * Runs automatically after `pnpm install` via the prepare script.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const MARKER = '# managed-by: scripts/install-hooks.mjs';

const PRE_COMMIT = `#!/bin/sh
${MARKER}
# Fast checks only. A slow hook is a bypassed hook — anything that needs the
# database or the full test suite belongs in CI, not here.
set -e

# Project invariants that no linter knows about (see CLAUDE.md and adr/).
node scripts/check-invariants.mjs --staged

# Formatting, so CI never fails on whitespace.
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(ts|tsx|js|mjs|cjs|json|md|ya?ml)$' || true)
if [ -n "$STAGED" ]; then
  echo "$STAGED" | xargs pnpm exec prettier --check || {
    echo ""
    echo "Formatting issues. Run: pnpm format"
    exit 1
  }
fi
`;

const PRE_PUSH = `#!/bin/sh
${MARKER}
# The repository is public and GitHub push protection on this plan matches
# known provider patterns only — it would miss a database password or a custom
# signing secret. This is the last point at which a leak is still preventable:
# once pushed, it is scraped within seconds and rewriting history does not
# un-leak it.
#
# Skipped silently when docker is unavailable, because a developer without
# docker must still be able to push. CI scans regardless.
set -e

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Scanning for secrets..."
  docker run --rm -v "$(pwd):/repo" -w /repo zricethezav/gitleaks:v8.24.3 \\
    detect --config .gitleaks.toml --source . --redact --no-banner || {
    echo ""
    echo "Secrets detected. Do not push."
    echo "If this is a false positive, add an allowlist entry to .gitleaks.toml"
    echo "with a comment explaining why."
    exit 1
  }
fi
`;

function gitDir() {
  try {
    return execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const dir = gitDir();
if (dir === null) {
  // A tarball or a vendored copy. Not an error.
  console.log('Not a git repository — skipping hook installation.');
  process.exit(0);
}

const hooksDir = join(dir, 'hooks');
mkdirSync(hooksDir, { recursive: true });

let installed = 0;
let skipped = 0;

for (const [name, body] of [
  ['pre-commit', PRE_COMMIT],
  ['pre-push', PRE_PUSH],
]) {
  const path = join(hooksDir, name);

  // Never clobber a hook someone wrote by hand. Only overwrite our own.
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.includes(MARKER)) {
      console.warn(
        `Skipped ${name}: an unmanaged hook already exists. ` +
          `Merge it manually or delete it and re-run.`,
      );
      skipped += 1;
      continue;
    }
    if (existing === body) continue;
  }

  writeFileSync(path, body, { mode: 0o755 });
  // Windows ignores the mode argument on write; set it explicitly for the
  // platforms that do not.
  try {
    chmodSync(path, 0o755);
  } catch {
    /* best effort */
  }
  installed += 1;
}

console.log(
  installed > 0
    ? `Git hooks installed (${installed}).`
    : skipped > 0
      ? 'Git hooks up to date, some skipped.'
      : 'Git hooks up to date.',
);
