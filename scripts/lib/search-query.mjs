/**
 * The radius query, lifted out of the adapter — slice 3.1c.
 *
 * **The measurement reads the SQL the application ships rather than restating
 * it**, which is the one decision in this pair of files worth defending. A
 * measurement script with its own hand-copied query measures a query nobody
 * runs: the two drift the first time somebody edits the real one, and the
 * numbers go on looking authoritative.
 *
 * In `lib/` for the reason `search-load-options.mjs` gives — the executable
 * carries a shebang and Vite cannot parse one, so anything with a test lives
 * here.
 */

/**
 * The agreed performance target.
 *
 * BRD §14's Phase 3 exit gate asks that search *"meets agreed performance on
 * seeded data"* without naming a number. **p95 under 200 ms at 50,000 publicly
 * visible listings** was proposed and accepted by the product owner on
 * 13 August 2026. It is a constant rather than prose because a gate number that
 * lives only in a docblock is one somebody re-decides by accident.
 */
export const TARGET_P95_MS = 200;

/**
 * The page size, and the deepest page anybody may ask for — slice 3.1d.
 *
 * Repeated here rather than imported, for the reason `measure-search.mjs`
 * repeats BRD §8.4's radii: a script cannot import the contract. They mirror
 * `SEARCH_PAGE_SIZE` and `MAX_SEARCH_PAGE` in `@platform/contracts`.
 *
 * **The deep page is measured, not assumed.** ADR 0045 chose offset pagination
 * over a keyset cursor on the argument that an O(n) skip costs nothing at the
 * depth anybody reaches. That is a claim about the database, and a claim about
 * the database that nobody measures is the kind this project has already been
 * caught by once — 3.1c's generator put fifty thousand listings in one city and
 * every number looked fine. So the last page is timed beside the first.
 */
export const PAGE_SIZE = 24;
export const DEEPEST_OFFSET = (20 - 1) * PAGE_SIZE;

/**
 * Fill the adapter's template literal in, or refuse.
 *
 * The substitution table is the contract between this script and
 * `prisma-listing-search.ts`. **An unrecognised placeholder throws**, because
 * the alternative is a query that runs and measures something else — and a
 * green number for the wrong statement is worse than no number at all.
 */
/**
 * The nine states §8.5.1 lets occupy a calendar, read out of the state machine
 * rather than restated (slice 4.9).
 *
 * **The same discipline this whole file exists for.** It lifts the SQL out of
 * the adapter so what is measured is what ships; a hand-copied list of states
 * would be the one thing here that could silently disagree with the application,
 * and it would disagree in the direction that makes the number look better —
 * fewer states, fewer rows excluded, a cheaper query than the one that runs.
 *
 * Throws rather than guessing. A script that cannot find the list has no
 * business reporting a duration.
 */
export function readCalendarOccupyingStates(machineSource) {
  const marker = 'CALENDAR_OCCUPYING_STATES';
  const start = machineSource.indexOf(`${marker}: readonly BookingState[]`);
  if (start === -1) throw new Error(`No ${marker} found in the state machine.`);

  /*
   * **From the `=`, not from the name.** The declaration is
   * `CALENDAR_OCCUPYING_STATES: readonly BookingState[] = Object.freeze([…])`,
   * and the first bracket after the name belongs to the *type annotation* — so
   * the obvious `indexOf('[')` lifts an empty pair and parses to nothing. Caught
   * by the test below, which is why the failure mode here is a throw rather than
   * an empty list quietly measuring a query with no state filter at all.
   */
  const assignment = machineSource.indexOf('=', start);
  const open = machineSource.indexOf('[', assignment);
  const close = machineSource.indexOf(']', open);
  if (assignment === -1 || open === -1 || close === -1) {
    throw new Error(`No ${marker} array literal.`);
  }

  const states = machineSource
    .slice(open + 1, close)
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter((entry) => /^[A-Z_]+$/.test(entry));

  if (states.length === 0) throw new Error(`${marker} parsed to nothing.`);
  return states;
}

/**
 * The availability predicate, as the adapter composes it.
 *
 * **Written out here rather than lifted**, unlike every other substitution in
 * this file, and the asymmetry is worth stating: the rest of the statement is
 * read out of `prisma-listing-search.ts`, but this fragment lives inside a
 * ternary that the crude template-literal lift cannot reach. What keeps the two
 * honest is the guard below — an adapter that grows a placeholder this file does
 * not know refuses to be measured at all — plus the states being read rather
 * than copied.
 *
 * The instants are interpolated rather than left as placeholders, because the
 * substitution pass does not re-scan what it produced.
 *
 * **They arrive as full ISO-8601 UTC strings rather than `Date`s** (slice 4.9,
 * amended). `measure-search.mjs` runs under a bare `node` at the repository
 * root, where `@platform/core` does not resolve, and `no-restricted-globals`
 * bans the `Date` constructor everywhere outside `*.test.ts` — so there was no
 * way for the executable to build one. The string is the stricter contract
 * anyway: `INSTANT` below refuses `'2026-09-01'`, where `new Date` on the same
 * input silently yields midnight UTC, which is the failure the ban exists for.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function freeForDates({ startAt, endAt }, states) {
  for (const [name, value] of [
    ['startAt', startAt],
    ['endAt', endAt],
  ]) {
    if (typeof value !== 'string' || !INSTANT.test(value)) {
      throw new Error(
        `dates.${name} must be a full ISO-8601 UTC instant like 2026-10-19T00:00:00.000Z, got ${JSON.stringify(value)}. A bare date is ambiguous and would be read as midnight UTC.`,
      );
    }
  }

  const from = `'${startAt}'::timestamptz`;
  const to = `'${endAt}'::timestamptz`;
  const list = states.map((state) => `'${state}'`).join(',');

  return `
        AND NOT EXISTS (
          SELECT 1 FROM "availability_blocks" b
          WHERE b."listingId" = l."id"
            AND b."startAt" < ${to}
            AND b."endAt" > ${from}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "bookings" bk
          WHERE bk."listingId" = l."id"
            AND bk."state" = ANY(ARRAY[${list}]::text[])
            AND bk."startAt" < ${to}
            AND bk."endAt" > ${from}
        )`;
}

export function buildQuery(
  source,
  {
    longitude,
    latitude,
    radiusMetres,
    limit,
    offset,
    categoryId = null,
    keyword = null,
    dates = null,
    /**
     * The nine, read from the state machine by the caller (slice 4.9).
     *
     * Required whenever `dates` is given, and deliberately not defaulted to a
     * literal here: a default would be the copied list this file refuses to keep.
     */
    occupyingStates = null,
  },
) {
  if (dates !== null && occupyingStates === null) {
    throw new Error('buildQuery needs occupyingStates when dates are given.');
  }

  const start = source.indexOf('$queryRaw');
  if (start === -1) throw new Error('No $queryRaw found in the adapter.');

  const open = source.indexOf('`', start);
  const close = source.indexOf('`', open + 1);
  if (open === -1 || close === -1) {
    throw new Error('No template literal after $queryRaw.');
  }

  /*
   * **Checked rather than coerced.** `String(undefined)` is `"undefined"`, which
   * would go into the SQL and fail — or worse, land somewhere Postgres tolerates
   * it. A caller who forgets the offset should be told, not measured.
   */
  for (const [name, value] of Object.entries({
    longitude,
    latitude,
    radiusMetres,
    limit,
    offset,
  })) {
    if (!Number.isFinite(value)) {
      throw new Error(`buildQuery needs a number for ${name}, got ${String(value)}.`);
    }
  }

  const substitutions = new Map([
    ['origin.longitude', String(longitude)],
    ['origin.latitude', String(latitude)],
    ['PUBLICLY_VISIBLE_STATUS', `'PUBLISHED'`],
    ['PUBLICLY_VISIBLE_MODERATION', `'APPROVED'`],
    ['radiusMetres', String(radiusMetres)],
    // Slice 3.1d moved both of these behind a `window` object. The names here
    // are the adapter's expressions verbatim — that is the whole contract.
    ['Paging.probe(window.limit)', String(limit + 1)],
    ['window.offset', String(offset)],
    /*
     * **A whole predicate rather than a value** — slice 3.2a, and it is the one
     * substitution here that is not a scalar.
     *
     * The adapter composes the category filter as a `Prisma.sql` fragment that
     * is `Prisma.empty` when nothing was chosen, so an unfiltered search runs a
     * statement **byte-identical to the one slice 3.1c measured the exit gate
     * against**. Reproducing that here means substituting the empty string,
     * which is why `categoryId` defaults to null: the numbers in the phase
     * handoff are for the unfiltered query, and this keeps measuring exactly it
     * unless a caller asks otherwise.
     */
    [
      'inCategory',
      categoryId === null ? '' : `AND l."categoryId" = '${categoryId}'::uuid`,
    ],
    /*
     * **The second composed predicate, on the same terms** — slice 3.3a. Absent
     * substitutes to the empty string so the unkeyworded statement stays the one
     * slice 3.1c measured.
     *
     * **The quoting here is this file's own problem and not the adapter's.** The
     * application binds the term as a parameter, so nothing a searcher types can
     * become syntax; this script has no parameter binding and interpolates, so
     * the quote is doubled. That is safe because the only caller is
     * `measure-search.mjs` with a term it chose itself — but it is exactly the
     * kind of asymmetry worth stating, because a reader who copies this line
     * back into the adapter would be writing an injection.
     */
    [
      'matchesKeyword',
      keyword === null
        ? ''
        : `AND l."searchDocument" @@ websearch_to_tsquery('english', '${String(keyword).replaceAll("'", "''")}')`,
    ],
    /*
     * **The third composed predicate, on the same terms** — slice 4.9. Absent
     * substitutes to the empty string, so the undated statement stays the one
     * slice 3.1c measured the exit gate against.
     *
     * **The instants are supplied already converted.** `periodFromLocalDates` is
     * TypeScript in another module, and re-implementing its timezone arithmetic
     * here would be the second implementation ADR 0003 exists to prevent. What
     * this measures is the shape and cost of the predicate; the arithmetic
     * behind its bounds is the adapter's and its tests'.
     */
    ['freeForDates', dates === null ? '' : freeForDates(dates, occupyingStates)],
  ]);

  return source
    .slice(open + 1, close)
    .replace(/\$\{([^}]+)\}/g, (_whole, expression) => {
      const value = substitutions.get(expression.trim());
      if (value === undefined) {
        throw new Error(
          `The adapter has a parameter this script does not know: \${${expression}}. Teach it before trusting any number.`,
        );
      }
      return value;
    })
    .trim();
}

/**
 * Nearest-rank, so the answer is always a number some run actually produced.
 *
 * With thirty runs the difference from an interpolating method is noise, and an
 * interpolated p95 can report a duration nothing ever took — which is a strange
 * thing to put in front of a gate.
 */
export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}
