import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  percentile,
  readCalendarOccupyingStates,
  TARGET_P95_MS,
} from './search-query.mjs';

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

/** The state machine, read the same way the adapter is (slice 4.9). */
const MACHINE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'api',
  'src',
  'booking',
  'booking-state-machine.ts',
);

const PARAMETERS = {
  longitude: -0.1278,
  latitude: 51.5074,
  radiusMetres: 8_046.72,
  limit: 24,
  offset: 0,
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

  it('skips the rows the requested page is past (slice 3.1d)', () => {
    // The measurement's whole point on a deep page: if the offset did not
    // arrive in the SQL, it would be timing page one twenty times and calling
    // it evidence that paging is cheap.
    expect(buildQuery(source, { ...PARAMETERS, offset: 456 })).toContain('OFFSET 456');
  });

  it('measures the first page when asked for offset zero', () => {
    expect(buildQuery(source, PARAMETERS)).toContain('OFFSET 0');
  });

  it('refuses a missing offset rather than writing "undefined" into the SQL', () => {
    expect(() => buildQuery(source, { ...PARAMETERS, offset: undefined })).toThrow(
      /needs a number for offset/,
    );
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

  /*
   * **The unfiltered statement must stay the one slice 3.1c measured** (slice
   * 3.2a). The whole reason the adapter composes the filter as a fragment rather
   * than writing `($1 IS NULL OR ...)` is that a dead predicate would change the
   * plan of every search — and the gate number in the phase handoff would then
   * describe a query nobody runs.
   */
  it('leaves no category predicate at all when none was asked for', () => {
    const sql = buildQuery(source, PARAMETERS);

    expect(sql).not.toContain('categoryId');
  });

  it('substitutes the category predicate when one is asked for', () => {
    const sql = buildQuery(source, {
      ...PARAMETERS,
      categoryId: '00000000-0000-4000-8000-000000000001',
    });

    expect(sql).toContain(
      `AND l."categoryId" = '00000000-0000-4000-8000-000000000001'::uuid`,
    );
    expect(sql).not.toContain('${');
  });

  /* The same pair for the keyword — slice 3.3a, same reasoning one filter on. */
  it('leaves no keyword predicate at all when none was asked for', () => {
    const sql = buildQuery(source, PARAMETERS);

    expect(sql).not.toContain('searchDocument');
    expect(sql).not.toContain('websearch_to_tsquery');
  });

  it('substitutes the keyword predicate when one is asked for', () => {
    const sql = buildQuery(source, { ...PARAMETERS, keyword: 'hedge trimmer' });

    expect(sql).toContain(
      `AND l."searchDocument" @@ websearch_to_tsquery('english', 'hedge trimmer')`,
    );
    expect(sql).not.toContain('${');
  });

  /*
   * **This script interpolates where the application binds**, which is safe only
   * because the sole caller supplies its own term — and is worth a test so the
   * escaping is not quietly dropped by somebody tidying the line. See the note
   * beside the substitution in `search-query.mjs`.
   */
  it('escapes a quote rather than ending the string early', () => {
    const sql = buildQuery(source, { ...PARAMETERS, keyword: "O'Brien mower" });

    expect(sql).toContain(`websearch_to_tsquery('english', 'O''Brien mower')`);
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

describe('the date filter (slice 4.9)', () => {
  /*
   * **Full ISO-8601 UTC strings, not `Date`s.** This took a `Date` until 4.9's
   * measurement needed to build one from `measure-search.mjs`, which runs under
   * a bare `node` where `@platform/core` does not resolve — and
   * `no-restricted-globals` refuses the constructor everywhere outside
   * `*.test.ts` (ADR 0003), so the executable had no way to produce one.
   *
   * The string is the stricter contract rather than the concession it looks
   * like: `buildQuery` refuses anything that is not a full instant, where
   * `new Date('2026-09-01')` would have accepted a bare date and silently meant
   * midnight UTC — the exact class of bug the ban exists for.
   */
  const DATES = {
    startAt: '2026-09-01T00:00:00.000Z',
    endAt: '2026-09-04T00:00:00.000Z',
  };

  it('leaves no availability predicate at all when no dates were asked for', () => {
    // The undated statement has to stay the one slice 3.1c measured the exit
    // gate against, which means an absent filter contributes nothing — not an
    // always-true clause (ADR 0046).
    const sql = buildQuery(readFileSync(ADAPTER, 'utf8'), PARAMETERS);

    expect(sql).not.toContain('availability_blocks');
    expect(sql).not.toContain('bookings');
  });

  it('excludes blocks and calendar-occupying bookings when they were', () => {
    const sql = buildQuery(readFileSync(ADAPTER, 'utf8'), {
      ...PARAMETERS,
      dates: DATES,
      occupyingStates: ['ACCEPTED', 'RESERVED'],
    });

    expect(sql).toContain('"availability_blocks"');
    expect(sql).toContain('"bookings"');
    expect(sql).toContain("ARRAY['ACCEPTED','RESERVED']::text[]");
    expect(sql).toContain("'2026-09-04T00:00:00.000Z'::timestamptz");
  });

  it('refuses to guess the states', () => {
    // A script that measured a cheaper query than the one that runs would make
    // the gate number a fiction, and fewer states is exactly the direction the
    // mistake goes in.
    expect(() =>
      buildQuery(readFileSync(ADAPTER, 'utf8'), { ...PARAMETERS, dates: DATES }),
    ).toThrow(/occupyingStates/);
  });

  it('refuses a bare date, which would silently mean midnight UTC', () => {
    // The protection the `Date` parameter used to imply and never actually gave:
    // `new Date('2026-09-01')` is a valid Date, so the old signature would have
    // measured a window nobody chose.
    expect(() =>
      buildQuery(readFileSync(ADAPTER, 'utf8'), {
        ...PARAMETERS,
        dates: { startAt: '2026-09-01', endAt: '2026-09-04' },
        occupyingStates: ['ACCEPTED'],
      }),
    ).toThrow(/full ISO-8601 UTC instant/);
  });

  it('leaves no placeholder behind with the filter on', () => {
    const sql = buildQuery(readFileSync(ADAPTER, 'utf8'), {
      ...PARAMETERS,
      dates: DATES,
      occupyingStates: ['ACCEPTED'],
    });

    expect(sql).not.toMatch(/\$\{/);
  });
});

describe('reading the nine states out of the state machine (slice 4.9)', () => {
  it('reads them rather than restating them', () => {
    // The same discipline as lifting the SQL: a copied list is the one thing
    // here that could silently disagree with the application.
    const states = readCalendarOccupyingStates(readFileSync(MACHINE, 'utf8'));

    expect(states).toContain('ACCEPTED');
    expect(states).toContain('PAYMENT_FAILED');
    expect(states).toContain('SECURITY_FAILED');
    // §7.1 keeps a request off the calendar on purpose.
    expect(states).not.toContain('REQUESTED');
    expect(states).not.toContain('DECLINED');
    expect(states).toHaveLength(9);
  });

  it('throws rather than guessing when it cannot find them', () => {
    expect(() => readCalendarOccupyingStates('export const SOMETHING = [];')).toThrow(
      /CALENDAR_OCCUPYING_STATES/,
    );
  });
});
