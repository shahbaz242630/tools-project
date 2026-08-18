import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { PrismaClient } from '@platform/database';
import type { BookingEventType, BookingState } from '@platform/contracts';
import { parseQuoteLineItems } from '@platform/contracts';
import { BookingStateChangedError, OverlappingBookingError } from './booking-store.js';
import type {
  AcceptanceResult,
  BookingEventRecord,
  BookingRecord,
  BookingStore,
  BookingWithEvents,
  NewBooking,
  NewBookingEvent,
  PendingRequest,
} from './booking-store.js';
import { overlaps } from './prisma-availability-store.js';

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

  create(booking: NewBooking): Promise<BookingRecord> {
    return this.write(booking, null);
  }

  createWithEvent(
    booking: NewBooking,
    event: Omit<NewBookingEvent, 'bookingId'>,
  ): Promise<BookingRecord> {
    return this.write(booking, event);
  }

  /**
   * The one write, with or without the first event.
   *
   * **One method behind both, because the deadlock retry must wrap whichever it
   * is.** Two copies of that loop is two places for the finding above to be
   * forgotten, and the version without the event is the one a later reader would
   * copy from.
   *
   * **A transaction only when there is an event to write.** A single `create` is
   * already atomic, and wrapping it would buy a second round trip and a longer
   * lock window on the busiest statement in the product for nothing.
   */
  private async write(
    booking: NewBooking,
    event: Omit<NewBookingEvent, 'bookingId'> | null,
  ): Promise<BookingRecord> {
    const data = {
      listingId: booking.listingId,
      renterId: booking.renterId,
      state: booking.state,
      startAt: booking.startAt,
      endAt: booking.endAt,
      timeZone: booking.timeZone,
      quoteId: booking.quoteId,
      categoryVersionId: booking.categoryVersionId,
      itemChargeAmount: booking.itemCharge.amount,
      renterFeeAmount: booking.renterFee.amount,
      totalAmount: booking.total.amount,
      currency: booking.total.currency,
      itemTitle: booking.itemTitle,
      categoryName: booking.categoryName,
      requestExpiresAt: booking.requestExpiresAt,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        const row =
          event === null
            ? await this.prisma.booking.create({ data })
            : await this.prisma.$transaction(async (tx) => {
                const created = await tx.booking.create({ data });

                await tx.bookingEvent.create({
                  data: {
                    bookingId: created.id,
                    type: event.type,
                    fromState: event.fromState,
                    toState: event.toState,
                    actorId: event.actorId,
                    metadata: { ...event.metadata },
                  },
                });

                return created;
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

  async findPendingRequests(
    listingId: string,
    ownerId: string,
    now: Date,
  ): Promise<readonly PendingRequest[]> {
    const rows = await this.prisma.booking.findMany({
      where: {
        // Owner-scoped in the query. See `findForParty` for why never after.
        listing: { id: listingId, ownerId },
        state: 'REQUESTED',
        // §8.6's deadline, honoured before 4.7's worker exists to enforce it.
        requestExpiresAt: { gt: now },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });

    /*
     * **The conflict count is computed in memory, over rows already in hand.**
     * §7.1 needs, per request, how many *others* overlap it — a self-join over a
     * set that is at most a handful of rows for one listing. A query per request
     * would be N+1 against one page, and a SQL self-join would be raw SQL this
     * module deliberately did not widen in 4.3a.
     *
     * The comparison is the same half-open rule, written directly on the dates
     * rather than through `overlaps` — that helper builds a *Prisma filter*, and
     * this is two rows being compared in memory.
     */
    return rows.map((row) => ({
      booking: toRecord(row),
      conflictCount: rows.filter(
        (other) =>
          other.id !== row.id && other.startAt < row.endAt && other.endAt > row.startAt,
      ).length,
    }));
  }

  async accept(
    bookingId: string,
    ownerId: string,
    now: Date,
  ): Promise<AcceptanceResult | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const booking = await tx.booking.findFirst({
            where: { id: bookingId, listing: { ownerId } },
          });
          // Not this owner's, or no such booking. Indistinguishable on purpose.
          if (booking === null) return null;

          const state = booking.state as BookingState;
          if (state !== 'REQUESTED') {
            /*
             * Expired, already declined, or accepted in another tab. Thrown
             * rather than returned so it rolls the transaction back, and so it
             * cannot be confused with the null above — the two need different
             * sentences and different status codes.
             */
            throw new BookingStateChangedError(bookingId, state);
          }

          if (booking.requestExpiresAt <= now) {
            // §8.6's deadline. 4.7 will move these to `EXPIRED`; until it does,
            // the deadline has to be honoured by whoever would act past it.
            throw new BookingStateChangedError(bookingId, state);
          }

          /*
           * **This update *is* the availability lock §7.1 asks for.** `ACCEPTED`
           * is one of §8.5.1's nine calendar-occupying states, so the `EXCLUDE`
           * constraint begins applying to this row the moment it lands — and a
           * second acceptance of overlapping dates is refused by Postgres rather
           * than noticed by us. There is deliberately no availability query
           * before this line: §8.5.1 names check-then-insert as the anti-pattern.
           */
          const accepted = await tx.booking.update({
            where: { id: bookingId },
            data: { state: 'ACCEPTED' },
          });

          await tx.bookingEvent.create({
            data: {
              bookingId,
              type: 'state-changed',
              fromState: 'REQUESTED',
              toState: 'ACCEPTED',
              actorId: ownerId,
              metadata: {},
            },
          });

          /*
           * **Every other `REQUESTED` booking overlapping the accepted period**
           * (§7.1). Read before writing, because the caller owes each of those
           * renters a notification and `updateMany` reports a count rather than
           * which rows it touched.
           */
          const conflicts = await tx.booking.findMany({
            where: {
              id: { not: bookingId },
              listingId: booking.listingId,
              state: 'REQUESTED',
              ...overlaps(booking.startAt, booking.endAt),
            },
            select: { id: true },
          });
          const autoDeclinedIds = conflicts.map((conflict) => conflict.id);

          if (autoDeclinedIds.length > 0) {
            await tx.booking.updateMany({
              where: { id: { in: autoDeclinedIds } },
              data: { state: 'DECLINED' },
            });

            await tx.bookingEvent.createMany({
              data: autoDeclinedIds.map((id) => ({
                bookingId: id,
                /*
                 * **Its own type, not `state-changed` carrying a reason.** The
                 * reason lives in `metadata`, and `bookingEventSchema` does not
                 * project metadata to a party — so without this the losing renter
                 * reads "declined" where §7.1 requires them to be told it was a
                 * conflict. The contract carries the full argument.
                 */
                type: 'auto-declined',
                fromState: 'REQUESTED',
                toState: 'DECLINED',
                // Nobody decided this. §6.2's actor is null for the platform.
                actorId: null,
                metadata: {
                  reason: 'AUTO_DECLINED_CONFLICT',
                  conflictingBookingId: bookingId,
                },
              })),
            });
          }

          return { booking: toRecord(accepted), autoDeclinedIds };
        });
      } catch (error) {
        // Somebody else's acceptance already holds these dates. Nothing about
        // that other booking crosses this boundary — see `OverlappingBookingError`.
        if (isOverlapViolation(error)) {
          throw new OverlappingBookingError(bookingId);
        }

        // The same finding as `write`: two acceptances racing on the exclusion
        // constraint deadlock rather than violate it, about one race in three.
        if (isDeadlock(error) && attempt < PrismaBookingStore.DEADLOCK_ATTEMPTS) {
          continue;
        }

        throw error;
      }
    }
  }

  async decline(
    bookingId: string,
    ownerId: string,
    now: Date,
  ): Promise<BookingRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, listing: { ownerId } },
      });
      if (booking === null) return null;

      const state = booking.state as BookingState;
      if (state !== 'REQUESTED') throw new BookingStateChangedError(bookingId, state);

      /*
       * **A decline past the deadline is allowed, and an acceptance is not.**
       * The asymmetry is deliberate: §8.6's deadline exists to stop a renter being
       * held indefinitely, and saying no after it costs them nothing they had not
       * already lost. Saying yes after it would bind somebody to a hire they were
       * entitled to consider dead.
       */
      void now;

      const declined = await tx.booking.update({
        where: { id: bookingId },
        data: { state: 'DECLINED' },
      });

      await tx.bookingEvent.create({
        data: {
          bookingId,
          type: 'state-changed',
          fromState: 'REQUESTED',
          toState: 'DECLINED',
          actorId: ownerId,
          metadata: {},
        },
      });

      return toRecord(declined);
    });
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

  async findForParty(id: string, userId: string): Promise<BookingWithEvents | null> {
    /*
     * **Both parties in one `OR`, in the query.** §8.6 gives the owner the
     * decision and the renter the record, so a booking has two legitimate
     * readers — and the owner is not a column here (see the schema: duplicating
     * it would let a row disagree with itself about who is owed the money), so
     * their side is expressed as a condition on the listing.
     *
     * The alternative — read it, then compare — is the pattern every
     * owner-scoped read in this project refuses: the row is already in memory
     * by the time the comparison runs, and the comparison is a line somebody can
     * delete.
     */
    const row = await this.prisma.booking.findFirst({
      where: {
        id,
        OR: [{ renterId: userId }, { listing: { ownerId: userId } }],
      },
      include: {
        // The breakdown §3.4.4 requires beside a total, from the quote the
        // booking was made from. `RESTRICT` on that foreign key is what makes
        // this join safe to rely on.
        quote: { select: { lineItems: true } },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (row === null) return null;

    return {
      booking: toRecord(row),
      lineItems: parseQuoteLineItems(
        row.quote.lineItems,
        `the line items on the quote behind booking ${row.id}`,
      ),
      events: row.events.map(toEventRecord),
    };
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
  quoteId: string;
  categoryVersionId: string;
  itemChargeAmount: number;
  renterFeeAmount: number;
  totalAmount: number;
  currency: string;
  itemTitle: string;
  categoryName: string;
  requestExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): BookingRecord {
  return {
    id: row.id,
    listingId: row.listingId,
    renterId: row.renterId,
    quoteId: row.quoteId,
    categoryVersionId: row.categoryVersionId,
    // One currency column, three amounts — reassembled here rather than at every
    // caller, and through `Money.money` so a row written by hand fails loudly
    // rather than becoming a price. `prisma-quote-store.ts` does the same.
    itemCharge: toMoney(row.itemChargeAmount, row.currency),
    renterFee: toMoney(row.renterFeeAmount, row.currency),
    total: toMoney(row.totalAmount, row.currency),
    itemTitle: row.itemTitle,
    categoryName: row.categoryName,
    requestExpiresAt: row.requestExpiresAt,
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

function toMoney(amount: number, currency: string): MoneyValue {
  return Money.money(amount, currency as MoneyValue['currency']);
}

/**
 * One history entry as this module reads it.
 *
 * The two state columns are cast for the same reason `state` is — the vocabulary
 * is kept honest by `booking-state-machine.ts` on the way in — and `metadata` is
 * narrowed to a record rather than parsed: nothing reads a specific key out of it
 * yet, and a schema per event type is what 4.6 will need when something does.
 */
function toEventRecord(row: {
  id: string;
  bookingId: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  actorId: string | null;
  metadata: unknown;
  createdAt: Date;
}): BookingEventRecord {
  return {
    id: row.id,
    bookingId: row.bookingId,
    type: row.type as BookingEventType,
    fromState: row.fromState as BookingState | null,
    toState: row.toState as BookingState | null,
    actorId: row.actorId,
    /*
     * **Narrowed rather than parsed, and flattened to scalars.** Nothing reads a
     * specific key out of metadata yet; when 4.6 does, that key gets a schema
     * rather than this getting looser. Anything that is not an object — which the
     * column's default `{}` makes unreachable through our writers — reads as
     * empty rather than throwing, because a booking's history should not be
     * unreadable because one entry's metadata is odd.
     */
    metadata:
      typeof row.metadata === 'object' && row.metadata !== null
        ? (row.metadata as Record<string, string | number | boolean | null>)
        : {},
    createdAt: row.createdAt,
  };
}
