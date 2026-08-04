#!/usr/bin/env node
/**
 * Fixture data for local development. **Not the launch category.**
 *
 * Why this exists, and why it should make you slightly uncomfortable:
 * categories are created by an administrator through `/admin/categories`, and
 * that page refuses everybody, because ADR 0021 requires a second factor and
 * multi-factor authentication is a paid feature on the plan this project is on.
 * That was accepted on 4 August 2026 as a cost to defer until the pilot — so
 * until it is paid for, nothing can create a category through the product, and
 * a listing needs a category to attach to.
 *
 * So: this writes one directly, with the loudest possible label on it.
 *
 *   - It writes to **`rental_dev` only**, and refuses any other database name.
 *   - Everything it creates is named so that nobody could mistake it for real
 *     configuration.
 *   - It writes **no audit entry**, and that is not an oversight to fix — it is
 *     the honest record that nobody did this. A seeded row with a fabricated
 *     actor would be worse than one with no trail at all.
 *
 * When the real launch category is created, it is created by a human in the
 * admin interface, with a reason, and the configuration to type is in
 * `docs/phase-02-categories-and-listings/launch-category-configuration.md`.
 *
 * Uses docker exec rather than a Postgres client library, for `verify-stack`'s
 * reason: no dependencies, and it exercises the same path a developer would by
 * hand.
 *
 * Usage:
 *   node scripts/seed-dev.mjs
 */

import { execFileSync } from 'node:child_process';

const PG_CONTAINER = 'rental-postgres';
const PG_USER = process.env.POSTGRES_USER ?? 'rental';

/**
 * Hard-coded rather than read from `POSTGRES_DB`.
 *
 * An environment variable is exactly what would be different on the machine
 * where this must never run. The one database this may touch is named here, in
 * the file, where a reviewer can see it.
 */
const DEVELOPMENT_DATABASE = 'rental_dev';

/** Unmistakable in a list, and unmistakable in a screenshot. */
const SEED_SLUG = 'seed-example-category';
const SEED_NAME = 'EXAMPLE (seeded fixture — not a real category)';

/**
 * An attribute schema exercising **all four types** (ADR 0027).
 *
 * Deliberately not the launch category's four. This is fixture data whose job is
 * to make every renderer and every validator reachable in a browser — the launch
 * category has no `choice-many` at all, so seeding a copy of it would leave one
 * of the four types unexercised by the only route anybody can actually use.
 *
 * The keys are close enough to real ones to read naturally and different enough
 * that nobody could paste this into `outdoor-gardening` by accident.
 */
const SEED_ATTRIBUTES = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'mains', label: 'Mains electric' },
      { value: 'cordless', label: 'Cordless battery' },
      { value: 'manual', label: 'Manual' },
    ],
  },
  {
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
  },
  {
    key: 'example_notes',
    label: 'Example notes',
    required: false,
    type: 'text',
    maxLength: 200,
  },
  {
    key: 'example_accessories',
    label: 'Accessories included',
    required: false,
    type: 'choice-many',
    options: [
      { value: 'case', label: 'Carry case' },
      { value: 'blade', label: 'Spare blade' },
      { value: 'charger', label: 'Charger' },
    ],
  },
];

/**
 * Escaped for a psql string literal, which doubles single quotes.
 *
 * The JSON is generated here rather than typed as a literal so the two cannot
 * drift, and the only character that needs handling is the quote — the labels
 * above are ours, not user input.
 */
function jsonLiteral(value) {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

function refuseUnlessDevelopment() {
  const environment = process.env.NODE_ENV ?? 'development';
  if (environment !== 'development' && environment !== 'test') {
    console.error(
      `Refusing to seed: NODE_ENV is "${environment}". This writes fixture data ` +
        'and must never run against a deployed environment.',
    );
    process.exit(1);
  }

  const target = process.env.POSTGRES_DB;
  if (target !== undefined && target !== DEVELOPMENT_DATABASE) {
    console.error(
      `Refusing to seed: POSTGRES_DB is "${target}", and this only ever writes to ` +
        `"${DEVELOPMENT_DATABASE}".`,
    );
    process.exit(1);
  }
}

function sql(statement) {
  return (
    execFileSync(
      'docker',
      [
        'exec',
        PG_CONTAINER,
        'psql',
        '-U',
        PG_USER,
        '-d',
        DEVELOPMENT_DATABASE,
        '-t',
        '-A',
        '-c',
        statement,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      // psql prints the command tag ("INSERT 0 1") after the returned row, even
      // with `-t -A`. Taking the first line is what turns the output back into
      // the single value the caller asked for.
      .split(/\r?\n/)[0]
      .trim()
  );
}

/**
 * Bring an already-seeded fixture up to the current schema, by **adding a
 * version** rather than editing one.
 *
 * `category_versions` refuses `UPDATE` — a trigger enforces it (slice 2.1) — and
 * that is not an obstacle to work around here: appending a version is what a
 * reconfiguration genuinely is, and it leaves the previous one in place for any
 * listing already pinned to it. Which is precisely the behaviour slice 2.4b
 * depends on, so it is worth the fixture data exercising it too.
 */
function reconfigureIfNeeded(categoryId, author) {
  const current = sql(
    `SELECT attributes::text FROM category_versions
      WHERE "categoryId" = '${categoryId}'
      ORDER BY "versionNumber" DESC LIMIT 1`,
  );

  if (current !== '' && JSON.parse(current).length > 0) {
    console.log(`Already seeded: ${SEED_SLUG} (${categoryId}). Nothing to do.`);
    return;
  }

  const version = sql(
    `INSERT INTO category_versions
       (id, "categoryId", "versionNumber", name, "riskLevel", "reportableActivity",
        attributes, "createdById", "createdAt")
     SELECT gen_random_uuid(), '${categoryId}',
            COALESCE(MAX("versionNumber"), 0) + 1, '${SEED_NAME}', 'medium', 'none',
            ${jsonLiteral(SEED_ATTRIBUTES)}, '${author}', now()
     FROM category_versions WHERE "categoryId" = '${categoryId}'
     RETURNING "versionNumber"`,
  );

  console.log(
    `Reconfigured ${SEED_SLUG} as version ${version}, adding the example attribute ` +
      'schema. Listings created before this keep the version they pinned.',
  );
}

function main() {
  refuseUnlessDevelopment();

  const author = sql('SELECT id FROM users ORDER BY "createdAt" ASC LIMIT 1');
  if (author === '') {
    console.error(
      'No user exists yet. Sign in once at http://localhost:3000 so the mirror row ' +
        'is created, then run this again.',
    );
    process.exit(1);
  }

  const existing = sql(`SELECT id FROM categories WHERE slug = '${SEED_SLUG}'`);
  if (existing !== '') {
    reconfigureIfNeeded(existing, author);
    return;
  }

  // **One statement, so the category and its version are written together.**
  // The real store does this in a transaction for a reason: a category with no
  // version has no configuration, and every read has to handle a state that
  // should not exist. The first draft of this script used two statements, the
  // second failed, and it left exactly that row behind — which is the state
  // `PrismaCategoryStore.toRecord` throws on.
  const categoryId = sql(
    `WITH author AS (SELECT id FROM users ORDER BY "createdAt" ASC LIMIT 1),
          new_category AS (
            INSERT INTO categories (id, slug, "createdAt")
            VALUES (gen_random_uuid(), '${SEED_SLUG}', now())
            RETURNING id
          )
     INSERT INTO category_versions
       (id, "categoryId", "versionNumber", name, "riskLevel", "reportableActivity",
        attributes, "createdById", "createdAt")
     SELECT gen_random_uuid(), new_category.id, 1, '${SEED_NAME}', 'medium', 'none',
            ${jsonLiteral(SEED_ATTRIBUTES)}, author.id, now()
     FROM new_category, author
     RETURNING "categoryId"`,
  );

  console.log(`Seeded ${SEED_SLUG} (${categoryId}).`);
  console.log('');
  console.log('  This is fixture data. It has no audit entry because nobody created');
  console.log('  it. Do not treat it as the launch category — that one gets made by a');
  console.log('  human in /admin/categories, once Clerk Pro is paid for.');
}

main();
