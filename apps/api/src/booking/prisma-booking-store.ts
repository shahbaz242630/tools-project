import type { PrismaClient } from '@platform/database';
import type { BookingState } from '@platform/contracts';
import { OverlappingBookingError } from './booking-store.js';
import type { BookingRecord, BookingStore, NewBooking } from './booking-store.js';

/**
 * Bookings in Postgres (slice 4.2).
 *
 * **This adapter is thin on purpose, because the interesting logic is in the
 * schema.** The overlap guarantee is an `EXCLUDE` constraint, the range is a
 * trigger-maintained column, and neither is expressible in Prisma — so what
 * this file mostly does is write two timestamps and translate one error. That
 * is the design §8.5.1 asks for: *"enforced by the database, not by
 * application-level check-then-insert logic, which is racy under concurrency."*
 *
 * **`period` is never written here and must not become writable.** It is
 * derived by `bookings_set_period` from `startAt` and `endAt`, exactly as
 * `fuzzedPoint` and `searchDocument` are derived. Prisma cannot express
 * `tstzrange` at all, which is what keeps the temptation away.
 */

/**
 * Postgres reports an exclusion-constraint violation as `23P01`, which Prisma
 * surfaces as `P2010` on a raw query and as an unknown-code error otherwise.
 *
 * **Matched on the constraint name rather than the code**, which is the
 * opposite of `isUniqueViolation` in `prisma-identity-store.ts` and worth the
 * difference: a unique violation is unambiguous, whereas this table carries two
 * `CHECK` constraints as well, and translating any of them into "those dates
 * are taken" would tell somebody the wrong thing about their own booking. The
 * name is ours, it is in the migration, and there is a db test that asserts a
 * real violation still matches it.
 *
 * Structural rather than `instanceof`, for the reason that file gives: the
 * generated client is emitted into a gitignored directory (ADR 0014) and its
 * error classes are not a stable surface.
 */
const OVERLAP_CONSTRAINT = 'booking_periods_do_not_overlap';

/** Everything Prisma knows about a failure, flattened to a string to search. */
function describe(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';

  const message =
    'message' in error ? String((error as { message: unknown }).message) : '';
  const meta =
    'meta' in error ? JSON.stringify((error as { meta: unknown }).meta ?? {}) : '';

  return `${message} ${meta}`;
}

function isOverlapViolation(error: unknown): boolean {
  return describe(error).includes(OVERLAP_CONSTRAINT);
}

/**
 * Postgres kills one of two transactions that are waiting on each other — and
 * **two simultaneous bookings for the same listing are exactly that**.
 *
 * This is the finding slice 4.2's concurrency test produced, and it is not what
 * anybody would predict. When two inserts race on an exclusion constraint,
 * neither can decide whether it conflicts until the other commits, so each takes
 * a `ShareLock` on the other's transaction and Postgres reports **`40P01`
 * deadlock detected** rather than `23P01` exclusion violation. The constraint
 * works — exactly one row survives — but the loser's error names no constraint
 * at all, so the first version of this adapter passed it through untranslated.
 *
 * **Left alone it would have been a 500 to a real renter.** Slice 4.6 accepts a
 * booking and auto-declines the losers per §7.1; it can only do that if it can
 * tell a conflict from a database failure. This arrives roughly one race in
 * three, so it would have been an intermittent server error on the busiest path
 * in the product — the one where two people want the same tool.
 */
function isDeadlock(error: unknown): boolean {
  return describe(error).includes('40P01');
}

export class PrismaBookingStore implements BookingStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * How many times a deadlocked insert is tried again.
   *
   * **Retrying is the canonical response to `40P01`, not a workaround.**
   * Postgres kills one of the two transactions *precisely so the other can
   * proceed*, and the victim is expected to try again — at which point the
   * winner has committed and the answer is unambiguous: either a clean
   * exclusion violation naming the constraint, or a success if the deadlock
   * came from something other than an overlap.
   *
   * **Retrying rather than translating the deadlock directly** is what keeps
   * this honest. A deadlock on this statement is *almost certainly* the overlap
   * race — nothing else here takes conflicting locks — but "almost certainly"
   * is not a thing to encode as "those dates are taken". The retry turns a
   * guess into an observation.
   *
   * Two is enough: after the first winner commits there is nothing left to
   * deadlock against, so a second failure would be a different problem and
   * should surface as one rather than being retried into a timeout.
   */
  private static readonly DEADLOCK_ATTEMPTS = 2;

  async create(booking: NewBooking): Promise<BookingRecord> {
    for (let attempt = 1; ; attempt++) {
      try {
        const row = await this.prisma.booking.create({
          data: {
            listingId: booking.listingId,
            renterId: booking.renterId,
            state: booking.state,
            startAt: booking.startAt,
            endAt: booking.endAt,
            timeZone: booking.timeZone,
          },
        });

        return toRecord(row);
      } catch (error) {
        /*
         * **Translated rather than rethrown**, so that 4.6's acceptance can tell
         * "somebody got there first" — an ordinary outcome it handles by
         * auto-declining per §7.1 — from a database that is unreachable, which
         * is a 500. Everything else propagates untouched, including the two
         * `CHECK` constraints, because a booking that ends before it starts is
         * a bug in the caller and should read like one.
         */
        if (isOverlapViolation(error)) {
          throw new OverlappingBookingError(booking.listingId);
        }

        // See `DEADLOCK_ATTEMPTS`: try again once, and let a second failure be
        // whatever it actually is.
        if (isDeadlock(error) && attempt < PrismaBookingStore.DEADLOCK_ATTEMPTS) {
          continue;
        }

        throw error;
      }
    }
  }

  async findBookedListings(
    listingIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    // An empty `IN ()` is not valid SQL and Prisma renders `in: []` as a query
    // that returns nothing, which is the right answer — but going to the
    // database to be told so is a round trip on the erasure path for an
    // account that owns no listings, which is most of them.
    if (listingIds.length === 0) return new Set();

    /*
     * **`distinct` rather than a `groupBy` or a count**, because the question
     * is membership: a listing with forty bookings and a listing with one are
     * the same answer, and selecting one column keeps the row that crosses this
     * boundary incapable of carrying anything about somebody else's rental.
     */
    const rows = await this.prisma.booking.findMany({
      where: { listingId: { in: [...listingIds] } },
      select: { listingId: true },
      distinct: ['listingId'],
    });

    return new Set(rows.map((row) => row.listingId));
  }
}

function toRecord(row: {
  id: string;
  listingId: string;
  renterId: string;
  state: string;
  startAt: Date;
  endAt: Date;
  timeZone: string;
  createdAt: Date;
  updatedAt: Date;
}): BookingRecord {
  return {
    id: row.id,
    listingId: row.listingId,
    renterId: row.renterId,
    /*
     * **Cast rather than validated, and the reason is where the vocabulary is
     * enforced.** The column is `text` because §7's table is the kind of thing
     * that gains a row, and Postgres enums need a migration to grow. What keeps
     * the value honest is `booking-state-machine.ts` on the way in — there is
     * no path that writes a state without going through it — plus the db test
     * that asserts the constraint's own list against `CALENDAR_OCCUPYING_STATES`.
     * Re-parsing here would be a fourth place for the vocabulary to live.
     */
    state: row.state as BookingState,
    startAt: row.startAt,
    endAt: row.endAt,
    timeZone: row.timeZone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
