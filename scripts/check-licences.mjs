#!/usr/bin/env node
/**
 * Fails when a dependency carries a licence incompatible with shipping a
 * commercial closed-source product.
 *
 * Copyleft licences are not "bad" — they are simply unusable here, because
 * distributing a linked work would oblige us to publish source we intend to
 * keep private once the repository goes private before launch.
 *
 * Run via `pnpm licences:check`. Reviewed manually when a new licence appears.
 */

import { execSync } from 'node:child_process';

/** Licences that would force us to publish our own source. */
const DENIED = new Set([
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
const REVIEW = new Set(['LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0']);

function readLicences() {
  // Fixed command with no interpolated input, so a shell is safe here. pnpm is
  // a .cmd shim on Windows and cannot be invoked without one.
  const raw = execSync('pnpm licenses list --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

let licences;
try {
  licences = readLicences();
} catch (error) {
  console.error('Could not read dependency licences:', String(error).split('\n')[0]);
  process.exit(1);
}

const denied = [];
const review = [];

for (const [licence, packages] of Object.entries(licences)) {
  const names = (Array.isArray(packages) ? packages : []).map(
    (p) => p.name ?? String(p),
  );
  if (DENIED.has(licence)) denied.push({ licence, names });
  else if (REVIEW.has(licence)) review.push({ licence, names });
}

console.log(`Licences in use: ${Object.keys(licences).sort().join(', ')}\n`);

for (const { licence, names } of review) {
  console.log(`NEEDS REVIEW  ${licence}: ${names.join(', ')}`);
}

for (const { licence, names } of denied) {
  console.log(`BLOCKED       ${licence}: ${names.join(', ')}`);
}

if (denied.length > 0) {
  console.error(
    `\n${denied.length} blocked licence(s) present. These would oblige us to ` +
      `publish our own source. Remove the dependency or find an alternative.`,
  );
  process.exit(1);
}

console.log(
  review.length > 0
    ? `\nNo blocked licences. ${review.length} need a human decision.\n`
    : '\nNo blocked licences.\n',
);
