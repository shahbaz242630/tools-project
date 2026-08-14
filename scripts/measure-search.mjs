#!/usr/bin/env node
/**
 * How fast the radius query actually is — slice 3.1c.
 *
 * BRD §14's Phase 3 exit gate asks that search *"meets agreed performance on
 * seeded data"*. The agreed target, settled with the product owner on 13 August
 * 2026, is **p95 under 200 ms at 50,000 publicly visible listings**, for any of
 * BRD §8.4's five radii.
 *
 * **It reads the SQL out of the adapter rather than restating it**, which is the
 * one decision in this file worth defending. A measurement script with its own
 * hand-copied query measures a query nobody ships: the two drift the first time
 * somebody edits the real one, and the numbers go on looking authoritative. This
 * lifts the template literal out of `prisma-listing-search.ts` and substitutes
 * the parameters, so **what is measured is what runs** — and if somebody adds a
 * placeholder this does not know, it fails loudly rather than quietly measuring
 * something malformed.
 *
 * Two things are measured, because they answer different questions:
 *
 *   - **`EXPLAIN ANALYZE`** — what the planner does, and whether the GiST index
 *     on `listing_locations.fuzzedPoint` is used at all. ADR 0044 left an open
 *     question here: a GiST index cannot be made partial on a predicate that
 *     lives in `listings`, and whether that costs anything is exactly what this
 *     answers.
 *   - **Repeated timings** — p50 and p95 over many runs, which is the number the
 *     gate is about.
 *
 * Needs `pnpm db:up` and data from `seed-search-load.mjs`.
 *
 * Usage:
 *   node scripts/measure-search.mjs
 *   node scripts/measure-search.mjs --runs 50 --database rental_dev
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildQuery,
  percentile,
  DEEPEST_OFFSET,
  PAGE_SIZE,
  TARGET_P95_MS,
} from './lib/search-query.mjs';

const PG_CONTAINER = 'rental-postgres';
const PG_USER = process.env.POSTGRES_USER ?? 'rental';
const HERE = dirname(fileURLToPath(import.meta.url));

const ADAPTER = join(
  HERE,
  '..',
  'apps',
  'api',
  'src',
  'search-location',
  'prisma-listing-search.ts',
);

/** BRD §8.4's radii. Repeated here because a script cannot import the contract. */
const RADII_MILES = [5, 10, 20, 50, 100];
const METRES_PER_MILE = 1_609.344;

/**
 * Origins to measure from, chosen to be unkind rather than representative.
 *
 * London is the densest cluster the generator makes, so a 100-mile search from
 * it is the largest result set available; Aberdeen is the sparsest neighbourhood
 * and measures the case where the index has to reject nearly everything.
 */
const ORIGINS = [
  ['London', 51.5074, -0.1278],
  ['Aberdeen', 57.1497, -2.0943],
];

function psql(database, sql) {
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
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
}

/** The server's own timing, so Node's round trip is not in the number. */
function timeOnce(database, sql) {
  const output = psql(database, `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
  const plan = JSON.parse(output);
  return plan[0]['Execution Time'];
}

function main() {
  const argv = process.argv.slice(2);
  const argument = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };

  const database = argument('database', 'rental_dev');
  const runs = Number(argument('runs', '30'));

  const source = readFileSync(ADAPTER, 'utf8');

  const visible = psql(
    database,
    `SELECT count(*) FROM "listings" WHERE status = 'PUBLISHED' AND "moderationState" = 'APPROVED';`,
  );

  console.log(`Database: ${database}`);
  console.log(`Publicly visible listings: ${visible}`);
  console.log(`Target: p95 < ${TARGET_P95_MS} ms\n`);

  let worst = 0;

  for (const [where, latitude, longitude] of ORIGINS) {
    for (const miles of RADII_MILES) {
      const sql = buildQuery(source, {
        longitude,
        latitude,
        radiusMetres: miles * METRES_PER_MILE,
        limit: PAGE_SIZE,
        offset: 0,
      });

      // One untimed run so the comparison is warm-cache to warm-cache. A cold
      // first read measures the disk, which is not what the gate asks about.
      timeOnce(database, sql);

      const timings = [];
      for (let run = 0; run < runs; run += 1) timings.push(timeOnce(database, sql));

      const p50 = percentile(timings, 0.5);
      const p95 = percentile(timings, 0.95);
      worst = Math.max(worst, p95);

      const verdict = p95 < TARGET_P95_MS ? 'ok' : 'OVER';
      /*
       * The two `toFixed` calls below are milliseconds, not money. The rule
       * exists because a float creeping into a total is how pence go wrong
       * (ADR 0002); a duration rounded to fit a console column is neither a
       * total nor pence.
       */
      // invariant-ok: no-tofixed — a duration in milliseconds, formatted for a log
      const row = `${where.padEnd(9)} ${String(miles).padStart(3)} mi   p50 ${p50.toFixed(1).padStart(7)} ms   p95 ${p95.toFixed(1).padStart(7)} ms   ${verdict}`;
      console.log(row);
    }
  }

  /*
   * **What the last page costs** — slice 3.1d, and the evidence ADR 0045 rests
   * on rather than an inference from the numbers above.
   *
   * Offset pagination skips rows the database has already found, so the honest
   * question is not "is page one fast" but "is the deepest page anybody may ask
   * for still fast". It is measured from the densest origin at the widest
   * radius, which is where the skip has the most rows to walk.
   */
  const deepest = buildQuery(source, {
    longitude: ORIGINS[0][2],
    latitude: ORIGINS[0][1],
    radiusMetres: 100 * METRES_PER_MILE,
    limit: PAGE_SIZE,
    offset: DEEPEST_OFFSET,
  });
  timeOnce(database, deepest);
  const deepTimings = [];
  for (let run = 0; run < runs; run += 1) {
    deepTimings.push(timeOnce(database, deepest));
  }
  const deepP95 = percentile(deepTimings, 0.95);
  worst = Math.max(worst, deepP95);

  // invariant-ok: no-tofixed — a duration in milliseconds, formatted for a log
  const deepRow = `${'London'.padEnd(9)} 100 mi   p50 ${percentile(deepTimings, 0.5).toFixed(1).padStart(7)} ms   p95 ${deepP95.toFixed(1).padStart(7)} ms   ${deepP95 < TARGET_P95_MS ? 'ok' : 'OVER'}   (offset ${String(DEEPEST_OFFSET)}, the last page)`;
  console.log(deepRow);

  // invariant-ok: no-tofixed — a duration in milliseconds, formatted for a log
  const summary = `\nWorst p95: ${worst.toFixed(1)} ms (target ${TARGET_P95_MS} ms)`;
  console.log(summary);

  // The plan for the widest search from the densest place — the one most likely
  // to abandon the index.
  const widest = buildQuery(source, {
    longitude: ORIGINS[0][2],
    latitude: ORIGINS[0][1],
    radiusMetres: 100 * METRES_PER_MILE,
    limit: PAGE_SIZE,
    offset: 0,
  });
  console.log(`\nPlan for London / 100 mi:\n`);
  console.log(psql(database, `EXPLAIN (ANALYZE, BUFFERS) ${widest}`));

  process.exitCode = worst < TARGET_P95_MS ? 0 : 1;
}

if (process.argv[1]?.endsWith('measure-search.mjs')) main();
