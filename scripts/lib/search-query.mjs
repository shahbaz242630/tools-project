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
export function buildQuery(
  source,
  { longitude, latitude, radiusMetres, limit, offset },
) {
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
