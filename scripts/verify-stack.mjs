#!/usr/bin/env node
/**
 * Verifies the local stack is not just running, but correctly configured.
 *
 * "Containers are up" is not the same as "PostGIS is installed and btree_gist
 * exists in both databases". A missing btree_gist would only surface much
 * later as a failed migration on the booking overlap constraint (BRD §8.5.1),
 * so it is checked explicitly here.
 *
 * Uses docker exec rather than a Postgres client library so this has no
 * dependencies and exercises the same path a developer would by hand.
 */

import { execFileSync } from 'node:child_process';

const REQUIRED_EXTENSIONS = ['postgis', 'btree_gist', 'pg_trgm', 'citext'];

/**
 * The PostGIS minor line staging serves, asserted rather than assumed.
 *
 * ADR 0032's radius search is measured against whatever PostGIS is underneath
 * it, and the Phase 3 exit gate is a number produced on one of them. The local
 * image tag is `17-3.5`, which floats: upstream publishes **no patch tags at
 * all**, so the tag can move from 3.5.0 to 3.5.2 — as it had by 19 August 2026,
 * while Neon still served 3.5.0 — and nothing said so. A patch difference is
 * tolerable and a minor one is not, so the minor is what is checked.
 *
 * **Raise this only after Neon has moved**, and check Neon by asking it rather
 * than by reading a note. From the box:
 *
 *     psql "$DIRECT_URL" -c "SELECT extversion FROM pg_extension WHERE extname='postgis'"
 */
const EXPECTED_POSTGIS_MINOR = '3.5';
const DATABASES = ['rental_dev', 'rental_test'];
const PG_CONTAINER = 'rental-postgres';
const REDIS_CONTAINER = 'rental-redis';
const PG_USER = process.env.POSTGRES_USER ?? 'rental';

let failures = 0;

function report(ok, label, detail = '') {
  const mark = ok ? '[32mPASS[0m' : '[31mFAIL[0m';
  console.log(`  ${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function dockerExec(container, args) {
  return execFileSync('docker', ['exec', container, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function psql(database, sql) {
  return dockerExec(PG_CONTAINER, ['psql', '-U', PG_USER, '-d', database, '-tAc', sql]);
}

function checkContainerRunning(name) {
  try {
    const state = execFileSync(
      'docker',
      ['inspect', '-f', '{{.State.Health.Status}}', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    report(state === 'healthy', `${name} is healthy`, state);
    return state === 'healthy';
  } catch {
    report(false, `${name} is healthy`, 'container not found — run pnpm db:up');
    return false;
  }
}

console.log('\nLocal stack verification\n');

console.log('Containers');
const pgUp = checkContainerRunning(PG_CONTAINER);
const redisUp = checkContainerRunning(REDIS_CONTAINER);

if (pgUp) {
  console.log('\nPostgres');
  for (const database of DATABASES) {
    // No initialiser: the catch below always continues, so a default would be
    // dead. ESLint 10's no-useless-assignment catches exactly this.
    let exists;
    try {
      exists =
        psql('postgres', `SELECT 1 FROM pg_database WHERE datname='${database}'`) ===
        '1';
    } catch (error) {
      report(false, `database ${database} exists`, String(error).split('\n')[0]);
      continue;
    }
    report(exists, `database ${database} exists`);
    if (!exists) continue;

    for (const extension of REQUIRED_EXTENSIONS) {
      try {
        const version = psql(
          database,
          `SELECT extversion FROM pg_extension WHERE extname='${extension}'`,
        );
        report(version !== '', `${database}: ${extension}`, version || 'not installed');

        if (extension === 'postgis' && version !== '') {
          // Minor, not patch — see EXPECTED_POSTGIS_MINOR. Compared as the
          // first two dot-separated parts so `3.5.0` and `3.5.2` agree and
          // `3.6.0` does not.
          const minor = version.split('.').slice(0, 2).join('.');
          report(
            minor === EXPECTED_POSTGIS_MINOR,
            `${database}: postgis is on the ${EXPECTED_POSTGIS_MINOR} line`,
            minor === EXPECTED_POSTGIS_MINOR
              ? version
              : `found ${version}, staging serves ${EXPECTED_POSTGIS_MINOR}.x`,
          );
        }
      } catch (error) {
        report(false, `${database}: ${extension}`, String(error).split('\n')[0]);
      }
    }
  }

  // The exclusion constraint in BRD §8.5.1 is the mechanism the whole
  // double-booking guarantee rests on. Prove it can actually be created here,
  // rather than discovering it cannot during a Phase 4 migration.
  console.log('\nBooking overlap constraint (BRD §8.5.1)');
  try {
    psql(
      'rental_test',
      `DROP TABLE IF EXISTS _verify_overlap;
       CREATE TABLE _verify_overlap (
         id int PRIMARY KEY,
         listing_id int NOT NULL,
         period tstzrange NOT NULL,
         EXCLUDE USING gist (listing_id WITH =, period WITH &&)
       );`,
    );
    psql(
      'rental_test',
      `INSERT INTO _verify_overlap VALUES
         (1, 1, tstzrange('2026-08-01','2026-08-05'));`,
    );

    let rejected = false;
    try {
      psql(
        'rental_test',
        `INSERT INTO _verify_overlap VALUES
           (2, 1, tstzrange('2026-08-03','2026-08-07'));`,
      );
    } catch {
      rejected = true;
    }
    report(rejected, 'overlapping period for same listing is rejected');

    let allowed = true;
    try {
      psql(
        'rental_test',
        `INSERT INTO _verify_overlap VALUES
           (3, 2, tstzrange('2026-08-03','2026-08-07'));`,
      );
    } catch {
      allowed = false;
    }
    report(allowed, 'same period for a different listing is allowed');

    psql('rental_test', 'DROP TABLE IF EXISTS _verify_overlap;');
  } catch (error) {
    report(false, 'exclusion constraint can be created', String(error).split('\n')[0]);
  }
}

if (redisUp) {
  console.log('\nRedis');
  try {
    report(
      dockerExec(REDIS_CONTAINER, ['redis-cli', 'ping']) === 'PONG',
      'responds to PING',
    );
  } catch (error) {
    report(false, 'responds to PING', String(error).split('\n')[0]);
  }
  try {
    // BullMQ requires noeviction. Any other policy can silently discard job
    // data under memory pressure, losing booking expiry and payout jobs.
    const policy = dockerExec(REDIS_CONTAINER, [
      'redis-cli',
      'config',
      'get',
      'maxmemory-policy',
    ]);
    const value = policy.split('\n').pop()?.trim();
    report(value === 'noeviction', 'maxmemory-policy is noeviction', value);
  } catch (error) {
    report(false, 'maxmemory-policy is noeviction', String(error).split('\n')[0]);
  }
}

console.log(
  failures === 0
    ? '\n[32mLocal stack is ready.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);

process.exit(failures === 0 ? 0 : 1);
