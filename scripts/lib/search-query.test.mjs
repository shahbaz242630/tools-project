import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildQuery, percentile, TARGET_P95_MS } from './search-query.mjs';

const ADAPTER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'api',
  'src',
  'search-location',
  'prisma-listing-search.ts',
);

const PARAMETERS = {
  longitude: -0.1278,
  latitude: 51.5074,
  radiusMetres: 8_046.72,
  limit: 24,
};

/**
 * **These tests are what stop the measurement rotting into fiction.**
 *
 * The script lifts its SQL out of the adapter rather than restating it, so that
 * what is measured is what runs. That only holds while the extraction keeps
 * working — and an extraction that quietly failed would leave a script
 * confidently reporting numbers for a query nobody ships.
 *
 * They read the real adapter rather than a fixture, deliberately. A fixture
 * would keep passing after somebody rewrote the query.
 */
describe('lifting the query out of the adapter', () => {
  const source = readFileSync(ADAPTER, 'utf8');

  it('finds the statement the application actually runs', () => {
    const sql = buildQuery(source, PARAMETERS);

    expect(sql).toContain('ST_DWithin');
    expect(sql).toContain('listing_locations');
    expect(sql).toContain('ORDER BY');
  });

  it('measures the fuzzed point, because that is what the application filters on', () => {
    /*
     * ADR 0032 makes filtering on the fuzzed point binding, and a measurement of
     * a true-point version would be measuring a query whose existence would be a
     * §8.4.1 breach. A cheap second place that would notice.
     */
    const sql = buildQuery(source, PARAMETERS);

    expect(sql).toContain('fuzzedPoint');
    expect(sql).not.toMatch(/ST_MakePoint\(\s*loc\."longitude"/);
  });

  it('leaves no placeholder behind', () => {
    // A `${...}` surviving into the SQL is a syntax error at best and a silently
    // different query at worst.
    expect(buildQuery(source, PARAMETERS)).not.toContain('${');
  });

  it('substitutes the origin it was given', () => {
    const sql = buildQuery(source, PARAMETERS);

    expect(sql).toContain('-0.1278');
    expect(sql).toContain('51.5074');
  });

  it('probes for one more row than the page, exactly as the adapter does', () => {
    expect(buildQuery(source, { ...PARAMETERS, limit: 24 })).toContain('LIMIT 25');
  });

  it('refuses a parameter it does not recognise, rather than guessing', () => {
    /*
     * **The failure this file exists for.** If the adapter grows a parameter,
     * the script must stop rather than produce a query that runs and measures
     * something else — a green number for the wrong statement is worse than no
     * number at all.
     */
    const grown = source.replace('${radiusMetres}', '${radiusMetres}, ${newThing}');

    expect(() => buildQuery(grown, PARAMETERS)).toThrow(/does not know/);
  });

  it('says so when there is no query to find', () => {
    expect(() => buildQuery('export class Nothing {}', PARAMETERS)).toThrow(
      /No \$queryRaw/,
    );
  });
});

describe('the percentile', () => {
  it('is the nearest rank, so it is always a number a run produced', () => {
    const runs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    expect(percentile(runs, 0.5)).toBe(50);
    expect(percentile(runs, 0.95)).toBe(100);
  });

  it('does not care what order the runs arrived in', () => {
    expect(percentile([90, 10, 50, 30, 70], 0.5)).toBe(50);
  });

  it('handles a single run', () => {
    expect(percentile([42], 0.95)).toBe(42);
  });
});

describe('the target', () => {
  it('is the one agreed with the product owner on 13 August 2026', () => {
    // A constant rather than prose, because a gate number that lives only in a
    // docblock is one somebody re-decides by accident.
    expect(TARGET_P95_MS).toBe(200);
  });
});
