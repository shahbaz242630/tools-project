import { Time } from '@platform/core';
import { CALENDAR_OCCUPYING_STATES } from '../booking-state-machine.js';
import { OverlappingBookingError } from '../booking-store.js';
import type { BookingRecord, BookingStore, NewBooking } from '../booking-store.js';

/**
 * Bookings without a database (slice 4.2).
 *
 * **It models the overlap rule and cannot prove it**, which is the division
 * every fake in this project draws and is sharper here than anywhere else. The
 * real guarantee is an `EXCLUDE` constraint holding under *concurrent
 * transactions* — that is the whole of BRD §8.5.1, and it is precisely what an
 * in-memory array cannot exhibit. What this reproduces is the *shape*: which
 * states block, that touching periods do not overlap, and that a conflict
 * arrives as `OverlappingBookingError` rather than as a silent second row.
 *
 * **So no test using this fake is evidence about double-booking.**
 * `prisma-booking-store.db.test.ts` is the only thing that can be, and it is
 * where the simultaneous-acceptance test the exit gate names actually lives.
 * A service test using this fake is checking that the service *handles* a
 * refusal, not that a refusal happens.
 */
export class InMemoryBookingStore implements BookingStore {
  private readonly bookings: BookingRecord[] = [];
  private nextId = 1;

  create(booking: NewBooking): Promise<BookingRecord> {
    /*
     * **`[)` and the nine states, mirroring the constraint.** Written as the
     * same two conditions the SQL applies rather than as a general
     * "do these dates clash" — a fake that was more permissive would let a
     * service pass while the database refused it, and one that was stricter
     * would make a legitimate back-to-back hire look broken in tests only.
     */
    const blocks =
      CALENDAR_OCCUPYING_STATES.includes(booking.state) &&
      this.bookings.some(
        (existing) =>
          existing.listingId === booking.listingId &&
          CALENDAR_OCCUPYING_STATES.includes(existing.state) &&
          existing.startAt < booking.endAt &&
          booking.startAt < existing.endAt,
      );

    if (blocks) return Promise.reject(new OverlappingBookingError(booking.listingId));

    /*
     * `Time.nowUtc()` rather than `new Date()`, which the lint rule refuses
     * across `apps/api` — ADR 0003's own consequence, in its words: *"a naive
     * `new Date()` in domain code is the exact mechanism by which this decision
     * gets undone."* Every other fake in this project does the same.
     */
    const now = Time.nowUtc();
    const record: BookingRecord = {
      ...booking,
      id: `booking-${String(this.nextId++)}`,
      createdAt: now,
      updatedAt: now,
    };

    this.bookings.push(record);
    return Promise.resolve(record);
  }

  findBookedListings(listingIds: readonly string[]): Promise<ReadonlySet<string>> {
    const wanted = new Set(listingIds);

    return Promise.resolve(
      new Set(
        this.bookings
          .map((booking) => booking.listingId)
          .filter((id) => wanted.has(id)),
      ),
    );
  }

  /**
   * Put a booking in without going through `create`, for the erasure tests.
   *
   * **It skips the overlap check deliberately.** Those tests are about which
   * listings are *referenced*, and making them construct a non-conflicting
   * period would be arranging around a rule they are not testing.
   */
  holds(listingId: string): this {
    const now = Time.nowUtc();
    this.bookings.push({
      id: `booking-${String(this.nextId++)}`,
      listingId,
      renterId: 'renter',
      state: 'REQUESTED',
      startAt: now,
      endAt: Time.addRentalDays(now, 1, 'Europe/London'),
      timeZone: 'Europe/London',
      createdAt: now,
      updatedAt: now,
    });
    return this;
  }
}

/**
 * The whole module's fakes, in one call — the shape every other module's
 * `testing/fakes.ts` offers, so a composition root in a test reads the same way
 * whichever module it is wiring.
 */
export function createBookingFakes(): {
  readonly store: InMemoryBookingStore;
  readonly references: { findBookedListings: BookingStore['findBookedListings'] };
} {
  const store = new InMemoryBookingStore();

  return {
    store,
    // The narrowed view Catalogue declares, built here rather than at each call
    // site so the boundary is stated once — the same arrangement `main.ts` uses
    // for `ListingProximity`.
    references: { findBookedListings: (ids) => store.findBookedListings(ids) },
  };
}
