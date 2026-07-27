#!/usr/bin/env node
/**
 * Fails when a workspace package cannot be loaded by a real Node process.
 *
 * The test suite resolves `@platform/*` to TypeScript source, which is fast and
 * gives readable failures, but means the built entry points are never executed.
 * That gap hid a genuine defect: every package declared
 * `"exports": { ".": "./src/index.ts" }`, so a running process resolved the
 * package to raw TypeScript, attempted type stripping, and died on the first
 * `export * from './money.js'` because only `money.ts` existed. The unit suite
 * was green throughout. Nothing had ever run outside vitest.
 *
 * This script imports each package the way a deployed process does: through its
 * declared runtime entry, in a real Node module graph, so internal specifiers
 * and cross-package imports are genuinely resolved.
 *
 * Run via `pnpm verify:runtime`, after `pnpm build`.
 */

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

/**
 * The path a running process would load. Mirrors Node's condition matching for
 * the cases we actually use — a bare string, or an object with `default`.
 */
function runtimeEntry(manifest) {
  const entry = manifest.exports?.['.'];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return entry.default ?? entry.import ?? entry.require ?? null;
  }
  return manifest.main ?? null;
}

const failures = [];
const checked = [];

let directories;
try {
  directories = await readdir(packagesDir, { withFileTypes: true });
} catch {
  console.error(`No packages directory at ${packagesDir}`);
  process.exit(1);
}

for (const directory of directories) {
  if (!directory.isDirectory()) continue;

  const packageDir = join(packagesDir, directory.name);
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    // stripBOM: a package.json written by a Windows editor can carry a byte
    // order mark, which JSON.parse rejects with a message that names neither
    // the file nor the cause.
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    failures.push(
      `${directory.name}: package.json is not valid JSON — ${String(error.message).split('\n')[0]}`,
    );
    continue;
  }

  const entry = runtimeEntry(manifest);

  if (!entry) {
    failures.push(`${manifest.name}: no runtime entry point declared`);
    continue;
  }

  if (entry.endsWith('.ts')) {
    failures.push(
      `${manifest.name}: runtime entry is TypeScript (${entry}). A deployed ` +
        `process cannot load this — point exports at built output.`,
    );
    continue;
  }

  const entryPath = join(packageDir, entry);
  if (!existsSync(entryPath)) {
    failures.push(
      `${manifest.name}: ${entry} does not exist. Run \`pnpm build\` first.`,
    );
    continue;
  }

  try {
    const loaded = await import(pathToFileURL(entryPath).href);
    const names = Object.keys(loaded).filter((key) => key !== 'default');
    if (names.length === 0) {
      failures.push(`${manifest.name}: loaded but exports nothing`);
      continue;
    }
    checked.push(`${manifest.name} (${names.length} exports)`);
  } catch (error) {
    failures.push(`${manifest.name}: ${String(error.message).split('\n')[0]}`);
  }
}

for (const entry of checked) {
  console.log(`  ok  ${entry}`);
}

if (failures.length > 0) {
  console.error('\nPackages that a deployed process could not load:\n');
  for (const failure of failures) {
    console.error(`  FAIL  ${failure}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`\nRuntime imports: ${checked.length} package(s) load correctly.\n`);
