#!/usr/bin/env node

/**
 * The §3.4.3 worked example, generated from the real configuration — slice 5.3a.
 *
 * **Not part of any test suite, deliberately**, following `measure-search.mjs`:
 * it reads the categories that actually exist in a database and writes a document
 * about them, which is a different job from asserting behaviour.
 *
 * ## What it does and what it refuses to do
 *
 * It reads every current category version out of the local database, runs each
 * through `apps/api/src/pricing/unit-economics.ts` at the values §3.4.3 names, and
 * writes `docs/unit-economics.md`. **It exits non-zero when any category's
 * contribution margin at its minimum booking total is negative**, because §3.4.3
 * says such a category may not be enabled for public booking — a gate that only
 * printed a warning would be a gate nobody notices.
 *
 * **The arithmetic is imported, never restated.** `measure-search.mjs` reads its
 * SQL out of the adapter for the same reason: a script with its own copy of the
 * model measures a model nobody runs, and the two drift the first time somebody
 * edits the real one.
 *
 * **It needs `pnpm build` first.** The pricing module is TypeScript compiled to
 * `apps/api/dist`, and an ESM script can only reach a CommonJS build through the
 * default export — hence `import pricing from …` rather than named imports, which
 * fail at load with a confusing message about missing exports.
 *
 * Usage:
 *   pnpm build && node scripts/unit-economics.mjs
 *   node scripts/unit-economics.mjs --database rental_dev --out docs/unit-economics.md
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ACTIVITY_LEVELS,
  formatMinor,
  meetsMinimumMarginRule,
  renderReport,
} from './lib/unit-economics-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PG_CONTAINER = 'rental-postgres';
const PG_USER = 'rental';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const database = argument('database', 'rental_dev');
const outPath = join(ROOT, argument('out', 'docs/unit-economics.md'));

function psql(sql) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-t',
      '-A',
      '-F',
      '|',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
}

async function loadPricing() {
  const built = join(ROOT, 'apps/api/dist/pricing/unit-economics.js');

  if (!existsSync(built)) {
    console.error(
      'apps/api/dist is missing. Run `pnpm build` first — this script imports the\n' +
        'real pricing model rather than restating it, so it needs the compiled output.',
    );
    process.exit(1);
  }

  /*
   * Default imports, not named ones. `apps/api` is CommonJS (ADR 0011) and Node's
   * interop exposes a CJS module's exports as the default binding; asking for a
   * named export here fails at load with "does not provide an export named …",
   * which reads like a missing function rather than a module-format mismatch.
   */
  const economics = await import(`file://${built}`);
  const costs = await import(
    `file://${join(ROOT, 'apps/api/dist/pricing/cost-model.js')}`
  );

  /*
   * `@platform/core` is ESM and exposes named exports directly, unlike the API's
   * CommonJS build above — which is why one is destructured and the other is not.
   * `Time` is imported rather than `new Date()` used, because ESLint bans the
   * global here and is right to: this project renders dates in the booking's
   * stored timezone, and a script quietly formatting in the runner's would be the
   * same class of bug that rule exists to stop.
   */
  const core = await import(`file://${join(ROOT, 'packages/core/dist/index.js')}`);

  return { economics: economics.default, costs: costs.default, Time: core.Time };
}

/**
 * The current version of every category, with its fee policy.
 *
 * **Current, not every version.** §3.4.3 asks whether a category may be enabled
 * for public booking, which is a question about the configuration in force — a
 * superseded version prices nothing new.
 */
function currentCategoryVersions() {
  const rows = psql(`
    select distinct on (c.id)
      c.slug,
      v."versionNumber",
      v."ownerCommissionBasisPoints",
      v."renterFeeBasisPoints",
      v."minimumBookingTotalAmount",
      v."minimumPlatformFeeAmount"
    from category_versions v
    join categories c on c.id = v."categoryId"
    order by c.id, v."versionNumber" desc
  `);

  if (rows === '') return [];

  return rows.split('\n').map((line) => {
    const [
      slug,
      versionNumber,
      ownerCommissionBasisPoints,
      renterFeeBasisPoints,
      minimumBookingTotalAmount,
      minimumPlatformFeeAmount,
    ] = line.split('|');

    return {
      slug,
      versionNumber: Number(versionNumber),
      ownerCommissionBasisPoints: Number(ownerCommissionBasisPoints),
      renterFeeBasisPoints: Number(renterFeeBasisPoints),
      minimumBookingTotalMinor: Number(minimumBookingTotalAmount),
      minimumPlatformFeeMinor: Number(minimumPlatformFeeAmount),
    };
  });
}

/**
 * The booking values §3.4.3 asks about.
 *
 * **The median is an assumption and is labelled as one.** No trading history
 * exists, so £25 is a stated placeholder rather than a measurement — the document
 * says so, and this is the line that changes when real bookings exist.
 *
 * **A category with no floor is still evaluated at a floor**, using £1: §3.4.2
 * requires a minimum booking total to be enforced, so a category configured at
 * zero has not set one, and showing what a £1 booking does is the whole point of
 * pointing that out.
 */
const ASSUMED_MEDIAN_MINOR = 2_500;
const NO_FLOOR_PROBE_MINOR = 100;

function bookingValuesFor(category) {
  const floor =
    category.minimumBookingTotalMinor > 0
      ? category.minimumBookingTotalMinor
      : NO_FLOOR_PROBE_MINOR;

  return [
    { minor: floor, isMinimumBookingTotal: true, isMedian: false },
    { minor: ASSUMED_MEDIAN_MINOR, isMinimumBookingTotal: false, isMedian: true },
  ];
}

async function main() {
  const { economics, costs, Time } = await loadPricing();
  const model = costs.UK_STRIPE_COST_MODEL;
  const gbp = (minor) => ({ amount: minor, currency: 'GBP' });

  const categories = currentCategoryVersions();

  if (categories.length === 0) {
    console.error(
      `No categories found in ${database}. Start the stack with \`pnpm db:up\` and make\n` +
        'sure the database has been migrated and has at least one category.',
    );
    process.exit(1);
  }

  const rendered = categories.map((category) => {
    const policy = {
      ownerCommissionBasisPoints: category.ownerCommissionBasisPoints,
      renterFeeBasisPoints: category.renterFeeBasisPoints,
      minimumBookingTotal: gbp(category.minimumBookingTotalMinor),
      minimumPlatformFee: gbp(category.minimumPlatformFeeMinor),
    };

    const rows = [];
    for (const value of bookingValuesFor(category)) {
      for (const bookingsPerMonth of ACTIVITY_LEVELS) {
        const result = economics.unitEconomicsOf(
          {
            grossBookingValue: gbp(value.minor),
            damageSecurityCaptured: gbp(0),
            bookingsPerActiveOwnerPerMonth: bookingsPerMonth,
          },
          policy,
          model,
        );

        rows.push({
          grossMinor: value.minor,
          isMinimumBookingTotal: value.isMinimumBookingTotal,
          isMedian: value.isMedian,
          bookingsPerMonth,
          renterPaysMinor: result.renterPays.amount,
          renterFeeMinor: result.renterFee.amount,
          ownerCommissionMinor: result.ownerCommission.amount,
          ownerProceedsMinor: result.ownerProceeds.amount,
          platformRevenueMinor: result.platformRevenue.amount,
          totalCostMinor: result.totalCost.amount,
          contributionMarginMinor: result.contributionMargin.amount,
        });
      }
    }

    const floorMinor = bookingValuesFor(category)[0].minor;
    const atFloor = economics.unitEconomicsOf(
      {
        grossBookingValue: gbp(floorMinor),
        damageSecurityCaptured: gbp(0),
        bookingsPerActiveOwnerPerMonth: 1,
      },
      policy,
      model,
    );

    return {
      ...category,
      rows,
      breakEvenBookingsPerMonth: economics.breakEvenOwnerActivity(
        { grossBookingValue: gbp(floorMinor), damageSecurityCaptured: gbp(0) },
        policy,
        model,
      ),
      floorCostBreakdown: Object.fromEntries(
        Object.entries(atFloor.costs).map(([name, amount]) => [name, amount.amount]),
      ),
    };
  });

  const document = renderReport({
    categories: rendered,
    assumptions: costs.assumptionsIn(model),
    generatedOn: Time.toLocalDateString(Time.nowUtc()),
    costModel: describeModel(model),
  });

  writeFileSync(outPath, document, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log('');

  let failed = false;
  for (const category of rendered) {
    const verdict = meetsMinimumMarginRule(category);
    const atFloor = category.rows.find(
      (row) => row.isMinimumBookingTotal && row.bookingsPerMonth === 1,
    );

    console.log(
      `${category.slug.padEnd(20)} floor ${formatMinor(atFloor.grossMinor).padEnd(8)} ` +
        `margin ${formatMinor(atFloor.contributionMarginMinor).padEnd(9)} ` +
        `break-even ${category.breakEvenBookingsPerMonth === null ? 'never' : `${String(category.breakEvenBookingsPerMonth)}/mo`.padEnd(6)} ` +
        `${verdict.passed ? 'PASS' : 'FAIL'}`,
    );

    if (!verdict.passed) {
      failed = true;
      console.error(`  §3.4.3: ${verdict.reason}`);
    }
  }

  if (failed) {
    console.error('');
    console.error(
      'BRD §3.4.3: a category may not be enabled for public booking if contribution\n' +
        'margin at the minimum booking total is negative. Raise the minimum booking\n' +
        'total, raise the fees, or accept the loss deliberately and record why.',
    );
    process.exit(1);
  }
}

/** The model as rows, so the document shows what it was computed from. */
function describeModel(model) {
  const described = [];

  for (const [field, component] of Object.entries(model)) {
    if (field === 'currency') continue;
    if (typeof component !== 'object' || component === null) continue;
    if (!('provenance' in component)) continue;

    const { value, provenance } = component;
    described.push({
      field,
      value: describeValue(value),
      source:
        provenance.kind === 'published'
          ? `[published](${provenance.source}), read ${provenance.readOn}`
          : '**assumption**',
    });
  }

  return described;
}

function describeValue(value) {
  if (typeof value === 'number') return String(value);
  if ('percent' in value)
    return `${String(value.percent)}% + ${formatMinor(value.fixed.amount)}`;
  return formatMinor(value.amount);
}

await main();
