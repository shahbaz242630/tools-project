/**
 * What the load generator was asked to do, and what it will refuse — slice 3.1c.
 *
 * **In `lib/` rather than in `seed-search-load.mjs`, and that is the
 * convention rather than taste.** Every executable in `scripts/` opens with a
 * shebang, which Vite cannot parse, so a test importing one fails with
 * `SyntaxError: Invalid or unexpected token` — as this slice discovered by
 * writing the test first and watching it happen. The pure logic lives here and
 * the executables stay unimportable, exactly as `log-args.mjs`,
 * `release-plan.mjs` and `shutdown-budget.mjs` already do.
 */

/**
 * The only databases the load generator may touch.
 *
 * **An allowlist, not a check against production's name**, for the reason every
 * guard in this repository is written that way: a denylist is wrong the moment
 * somebody adds an environment. Neon is not on it and cannot be — the generator
 * speaks to a local container by name, so there is no connection string to
 * point elsewhere even by accident.
 */
export const ALLOWED_DATABASES = new Set(['rental_dev', 'rental_test']);

/** The count BRD §14's exit gate asks about. */
export const GATE_COUNT = 50_000;

/**
 * A guardrail rather than a limit anybody should meet.
 *
 * Above this the measurement stops being about the query and starts being about
 * whether a laptop has the disk for it.
 */
export const MAXIMUM_COUNT = 200_000;

export function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    args.set(
      token.slice(2),
      next !== undefined && !next.startsWith('--') ? next : 'true',
    );
  }

  const database = args.get('database') ?? 'rental_dev';
  if (!ALLOWED_DATABASES.has(database)) {
    throw new Error(
      `Refusing to touch "${database}". This writes tens of thousands of fake rows and may only run against ${[...ALLOWED_DATABASES].join(' or ')}.`,
    );
  }

  const clean = args.get('clean') === 'true';
  const rawCount = args.get('count');
  const count = rawCount === undefined ? GATE_COUNT : Number(rawCount);

  if (!clean) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`--count must be a positive whole number, got "${rawCount}".`);
    }
    if (count > MAXIMUM_COUNT) {
      throw new Error(
        `--count of ${count} is beyond what this is for. The gate asks for ${GATE_COUNT}.`,
      );
    }
  }

  /**
   * `raw` is handed back so the calendar shares can be parsed beside these
   * without a second pass over `argv` — see `parseCalendarShares` in
   * `booking-load.mjs`. Two tokenisers over one command line is how a flag comes
   * to mean different things to different halves of the same script.
   */
  return { database, count, clean, raw: args };
}
