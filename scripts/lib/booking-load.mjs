/**
 * The booked and blocked calendar the dated search is measured against — 4.9.
 *
 * **Why this file exists at all.** ADR 0049 put the date filter *inside* the
 * radius query as two `NOT EXISTS` subqueries, and recorded — rather than hid —
 * that the dated statement had never been measured against a loaded database.
 * `seed-search-load.mjs` writes listings and nothing else, so measuring it as it
 * stood would have run both subqueries against **empty tables**: the cheapest
 * possible answer, reported as a gate number. That is the failure this script's
 * own history already contains once, when every listing landed in Plymouth and
 * the measurement passed comfortably against `rows=0`.
 *
 * So the calendar has to be populated before the number means anything, and the
 * shape of what gets written is a measurement decision rather than a fixture
 * detail. Four of them are load-bearing:
 *
 *   - **The season is fixed, not relative to today.** A performance number you
 *     cannot reproduce next month is an anecdote. It is also what keeps `Date`
 *     out of here — `no-restricted-globals` bans it workspace-wide, and the
 *     anchor being a SQL literal leaves the clock in the database, which is
 *     where the rows are written anyway.
 *   - **Slots make an overlap unreachable rather than unlikely.** §8.5.1's
 *     `EXCLUDE` constraint refuses two occupying bookings on one listing, and it
 *     would refuse them *mid-seed*, after tens of thousands of rows. A layout
 *     that merely makes collisions rare is one that fails on a big enough run.
 *   - **The states are read, not restated**, exactly as `search-query.mjs`
 *     already reads the occupying nine. A hand-copied list here would disagree
 *     with the application in the direction that flatters the number.
 *   - **Both sides of the state predicate are seeded.** If every booking were
 *     calendar-occupying, `state = ANY(...)` would filter nothing and the
 *     measurement would flatter the index. Rows it must examine and reject are
 *     the work the predicate actually does in production.
 */

/**
 * Where the seeded season starts.
 *
 * A literal, interpolated into SQL as a `timestamptz`, and shared by the seed
 * and the measurement so the two cannot drift onto different months. **If these
 * disagree the dated measurement silently matches nothing** — a fast query over
 * an empty answer, which is the exact thing this file exists to prevent. The
 * test pins the measured window inside the season for that reason.
 */
export const SEASON_ANCHOR = '2026-10-01';

/** One slot per booking, wide enough that a hire can never leave its own. */
export const SLOT_DAYS = 14;

/**
 * How many fortnights the seeded season runs for.
 *
 * **Four, and the first attempt at this used twenty-four — a year — which
 * produced a fixture the date filter never touched.** Spread over that many
 * slots, a booked listing's two-or-three bookings land almost anywhere, and a
 * realistic three-day search intersects nearly none of them: the trial run
 * reported *80 of 80 listings free*, so both subqueries probed their indexes,
 * missed every time, and timed a path that never takes the exclusion branch.
 *
 * A short season is the fixture equivalent of the clustering argument this
 * generator already makes about geography — supply that is spread thin enough
 * measures nothing. Fifty-six days is dense enough that a search inside it meets
 * a meaningful share of the calendar, which is what the guard in
 * `measure-search.mjs` now refuses to proceed without.
 */
export const SLOT_COUNT = 4;

/** The longest hire the generator writes. Strictly under `SLOT_DAYS` — see `slotOf`. */
export const MAXIMUM_HIRE_DAYS = 10;

/** At most this many bookings per booked listing. */
export const MAXIMUM_BOOKINGS_PER_LISTING = 3;

/**
 * How far apart one listing's own bookings sit, in slots.
 *
 * Coprime with `SLOT_COUNT`, which is the whole reason for the number: it makes
 * `(i + SLOT_STRIDE * k) % SLOT_COUNT` distinct for every k below `SLOT_COUNT`,
 * so two of one listing's bookings cannot land in the same fortnight. 7 and 4
 * share no factor; 6 and 4 would put a listing's first and third booking in one
 * slot, which the `EXCLUDE` constraint would refuse mid-seed.
 */
export const SLOT_STRIDE = 7;

/**
 * The window the dated search is measured over.
 *
 * **Three days, because that is what a renter asks for** — a window spanning the
 * whole season would be excluded by nearly every booking and measure a query
 * returning almost nothing, which is fast and about nothing.
 *
 * **Aligned to the start of slot 1**, which is the part that took a trial run to
 * get right. Every seeded hire begins at its slot's first instant and runs one
 * to ten days, so a window that opens with the slot overlaps *every* booking in
 * it regardless of length. A window opening mid-slot would catch only the longer
 * hires, making how hard the filter bites depend on the duration formula — a
 * coupling nobody would remember when changing either.
 */
export const MEASURED_WINDOW = {
  startAt: '2026-10-15T00:00:00.000Z',
  endAt: '2026-10-18T00:00:00.000Z',
};

/**
 * Which slot a listing's k-th booking occupies, and how long the hire runs.
 *
 * Pure, and separately tested, because the non-overlap guarantee is the one
 * property whose failure is a mid-seed constraint violation rather than a wrong
 * number.
 */
export function slotOf(listingIndex, bookingIndex) {
  return (listingIndex + SLOT_STRIDE * bookingIndex) % SLOT_COUNT;
}

export function hireDaysOf(listingIndex, bookingIndex) {
  return 1 + ((listingIndex + bookingIndex) % MAXIMUM_HIRE_DAYS);
}

/** How many bookings a booked listing carries — 1 to `MAXIMUM_BOOKINGS_PER_LISTING`. */
export function bookingCountOf(listingIndex) {
  return 1 + (listingIndex % MAXIMUM_BOOKINGS_PER_LISTING);
}

/**
 * The full state vocabulary, lifted out of the contract.
 *
 * The sibling of `readCalendarOccupyingStates` in `search-query.mjs` and written
 * the same way, deliberately: this file needs the states that are *not* on the
 * calendar, and the honest way to get them is the whole list minus the nine
 * rather than a second hand-copied list that can rot on its own.
 */
export function readBookingStates(contractsSource) {
  const marker = 'BOOKING_STATES';
  const start = contractsSource.indexOf(`export const ${marker} = [`);
  if (start === -1) throw new Error(`No ${marker} found in the contract.`);

  const open = contractsSource.indexOf('[', start);
  const close = contractsSource.indexOf(']', open);
  if (open === -1 || close === -1) throw new Error(`No ${marker} array literal.`);

  const states = contractsSource
    .slice(open + 1, close)
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter((entry) => /^[A-Z_]+$/.test(entry));

  if (states.length === 0) throw new Error(`${marker} parsed to nothing.`);
  return states;
}

/**
 * The two pools a seeded booking's state is drawn from.
 *
 * **Throws when either side is empty**, rather than seeding a calendar made
 * entirely of one kind. An all-occupying calendar makes `state = ANY(...)` filter
 * nothing; an all-other one makes the subquery match nothing and every listing
 * look free. Both produce a fast query and a meaningless number, so neither is
 * allowed to happen quietly.
 */
export function statePools(allStates, occupyingStates) {
  const occupying = allStates.filter((state) => occupyingStates.includes(state));
  const other = allStates.filter((state) => !occupyingStates.includes(state));

  if (occupying.length === 0) throw new Error('No calendar-occupying states to seed.');
  if (other.length === 0) throw new Error('No non-occupying states to seed.');

  return { occupying, other };
}

/**
 * Which listings carry a calendar, by index.
 *
 * **Modulo 100 rather than `random()`**, so a share is exact and a run is
 * reproducible — and so the two selections are **disjoint by construction**
 * rather than by luck. Booked listings take the bottom of each hundred and
 * blocked ones the top; the guard in `parseCalendarShares` is what keeps them
 * from meeting in the middle.
 */
export function isBooked(listingIndex, bookedPercent) {
  return listingIndex % 100 < bookedPercent;
}

export function isBlocked(listingIndex, blockedPercent) {
  return listingIndex % 100 >= 100 - blockedPercent;
}

/** The defaults. The reasoning for them is in `parseCalendarShares`. */
export const DEFAULT_BOOKED_PERCENT = 20;
export const DEFAULT_BLOCKED_PERCENT = 10;

/**
 * How much of the catalogue carries a calendar.
 *
 * **Deliberately generous rather than representative**, and the direction is the
 * point: every booked or blocked listing is a row the two subqueries must find
 * and reject, so more of them makes the measured query *slower*. A gate number
 * should err pessimistic, because the failure mode of an optimistic one is
 * discovering the truth in production.
 */
export function parseCalendarShares(args) {
  const read = (name, fallback) => {
    const raw = args.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`--${name} must be a whole number of percent, got "${raw}".`);
    }
    return value;
  };

  const bookedPercent = read('booked-percent', DEFAULT_BOOKED_PERCENT);
  const blockedPercent = read('blocked-percent', DEFAULT_BLOCKED_PERCENT);

  if (bookedPercent + blockedPercent > 100) {
    throw new Error(
      `--booked-percent and --blocked-percent must sum to 100 or less, got ${bookedPercent} + ${blockedPercent}. They select disjoint ends of each hundred listings and would otherwise overlap.`,
    );
  }

  return { bookedPercent, blockedPercent };
}
