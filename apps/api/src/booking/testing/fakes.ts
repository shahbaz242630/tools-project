import { Time } from '@platform/core';
import type { BookingEventType, BookingState } from '@platform/contracts';
import { CALENDAR_OCCUPYING_STATES } from '../booking-state-machine.js';
import {
  BookingStateChangedError,
  DuplicateQuoteBookingError,
  OverlappingBookingError,
} from '../booking-store.js';
import type {
  AcceptanceResult,
  ExpirySweepResult,
  BookingEventRecord,
  BookingRecord,
  BookingStore,
  BookingWithEvents,
  NewBooking,
  NewBookingEvent,
  PendingRequest,
} from '../booking-store.js';
import type {
  AvailabilityBlockRecord,
  BookedPeriodRecord,
  AvailabilityStore,
  NewAvailabilityBlock,
  UnavailableReason,
} from '../availability-store.js';
import type { ListingOwnership } from '../listing-ownership.js';
import type {
  HireChargeRequest,
  HireChargeResult,
  HirePayments,
} from '../hire-payments.js';
import type {
  CollectionSecurity,
  CollectionSecurityRequest,
  CollectionSecurityResult,
} from '../damage-security.js';
import type { ListingQuoteSource, QuotableListing } from '../listing-quote-source.js';
import type {
  ExportableQuote,
  NewQuote,
  QuoteRecord,
  QuoteStore,
} from '../quote-store.js';
import { createRecordingLogger } from '@platform/observability/testing';
import { paymentsModuleFakes } from '../../payments/testing/fakes.js';
import type { ReconciliationService } from '../../payments/reconciliation.service.js';
import { AvailabilityService } from '../availability.service.js';
import { RequestExpiryService } from '../request-expiry.service.js';
import { QuotesService } from '../quotes.service.js';
import { BookingsService } from '../bookings.service.js';

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
  private readonly events: BookingEventRecord[] = [];
  private nextId = 1;

  /**
   * The clock this store stamps rows with (slice 4.5a).
   *
   * **Injected, because a booking's *history* is now something a test asserts.**
   * `Time.nowUtc()` was fine while nothing read a timestamp back; the moment §6.2's
   * event log became a projection, a fake stamping the real clock made the one
   * assertion that matters — *what happened and when* — impossible to write
   * without matching against `expect.any(String)`, which asserts nothing.
   *
   * Defaults to the real clock, so a test that does not care need not say.
   */
  constructor(private readonly now: () => Date = Time.nowUtc) {}

  /**
   * The listing owners this store knows about, so `findForParty` can answer the
   * owner's side (slice 4.5a).
   *
   * **The real query reaches through `listing.ownerId`**, which this fake has no
   * access to — so a test states the ownership it needs. Stated rather than
   * inferred: a fake that guessed an owner would let a test pass while the real
   * query returned nothing.
   */
  private readonly owners = new Map<string, string>();

  /** Record who owns a listing, for the owner side of `findForParty`. */
  givenOwner(listingId: string, ownerId: string): this {
    this.owners.set(listingId, ownerId);
    return this;
  }

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
     * **The unique index slice 4.7a put on `quoteId`, modelled for the same reason
     * the overlap rule is.** A fake more permissive than the database lets a service
     * pass a test the real store would fail — and this is precisely such a case: the
     * `EXCLUDE` constraint cannot see two `REQUESTED` duplicates (§7.1 keeps
     * `REQUESTED` out of the nine occupying states), so without this the fake would
     * happily make two bookings from one quote and the refusal would only ever be
     * discovered in production.
     */
    if (this.bookings.some((existing) => existing.quoteId === booking.quoteId)) {
      return Promise.reject(new DuplicateQuoteBookingError(booking.quoteId));
    }

    /*
     * `Time.nowUtc()` rather than `new Date()`, which the lint rule refuses
     * across `apps/api` — ADR 0003's own consequence, in its words: *"a naive
     * `new Date()` in domain code is the exact mechanism by which this decision
     * gets undone."* Every other fake in this project does the same.
     */
    const now = this.now();
    const record: BookingRecord = {
      ...booking,
      id: `booking-${String(this.nextId++)}`,
      createdAt: now,
      updatedAt: now,
    };

    this.bookings.push(record);
    return Promise.resolve(record);
  }

  /**
   * A booking and its first event (slice 4.5a).
   *
   * **The atomicity is exactly what this fake cannot model**, and that is the
   * division every fake here draws: `create` above either refuses or succeeds, so
   * writing the event after it can never be interrupted in memory. What the real
   * store guarantees is that a rolled-back booking leaves no event behind, and
   * only `prisma-booking-store.db.test.ts` can be evidence of that.
   */
  async createWithEvent(
    booking: NewBooking,
    event: Omit<NewBookingEvent, 'bookingId'>,
  ): Promise<BookingRecord> {
    const created = await this.create(booking);

    this.events.push({
      ...event,
      bookingId: created.id,
      id: `event-${String(this.events.length + 1)}`,
      createdAt: this.now(),
    });

    return created;
  }

  findPendingRequests(
    listingId: string,
    ownerId: string,
    now: Date,
  ): Promise<readonly PendingRequest[]> {
    const rows = this.bookings
      .filter(
        (booking) =>
          booking.listingId === listingId &&
          this.owners.get(booking.listingId) === ownerId &&
          booking.state === 'REQUESTED' &&
          booking.requestExpiresAt > now,
      )
      .sort(
        (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
      );

    return Promise.resolve(
      rows.map((booking) => ({
        booking,
        conflictCount: rows.filter(
          (other) =>
            other.id !== booking.id &&
            other.startAt < booking.endAt &&
            other.endAt > booking.startAt,
        ).length,
      })),
    );
  }

  /**
   * Acceptance, and the one thing this fake genuinely cannot model.
   *
   * **The overlap refusal and the auto-decline are modelled; the atomicity
   * between them is not.** In memory nothing can interrupt the two, so a test
   * here can never be evidence that a refused acceptance leaves no auto-decline
   * behind — that is `prisma-booking-store.db.test.ts`'s, and §7.1's *"single
   * database transaction"* is a claim only a database can support.
   *
   * What this is good for is the sequence: which states are reached, which events
   * are written, and which competing requests fall.
   */
  accept(
    bookingId: string,
    ownerId: string,
    now: Date,
  ): Promise<AcceptanceResult | null> {
    const booking = this.bookings.find(
      (row) => row.id === bookingId && this.owners.get(row.listingId) === ownerId,
    );
    if (booking === undefined) return Promise.resolve(null);

    if (booking.state !== 'REQUESTED' || booking.requestExpiresAt <= now) {
      return Promise.reject(new BookingStateChangedError(bookingId, booking.state));
    }

    // The same two conditions the constraint applies. See `create` above.
    const taken = this.bookings.some(
      (other) =>
        other.id !== booking.id &&
        other.listingId === booking.listingId &&
        CALENDAR_OCCUPYING_STATES.includes(other.state) &&
        other.startAt < booking.endAt &&
        booking.startAt < other.endAt,
    );
    if (taken) return Promise.reject(new OverlappingBookingError(bookingId));

    this.replace(booking, 'ACCEPTED');
    this.record(booking.id, 'state-changed', 'REQUESTED', 'ACCEPTED', ownerId, {});

    const conflicts = this.bookings.filter(
      (other) =>
        other.id !== booking.id &&
        other.listingId === booking.listingId &&
        other.state === 'REQUESTED' &&
        other.startAt < booking.endAt &&
        other.endAt > booking.startAt,
    );

    for (const conflict of conflicts) {
      this.replace(conflict, 'DECLINED');
      this.record(conflict.id, 'auto-declined', 'REQUESTED', 'DECLINED', null, {
        reason: 'AUTO_DECLINED_CONFLICT',
        conflictingBookingId: booking.id,
      });
    }

    return Promise.resolve({
      booking: { ...booking, state: 'ACCEPTED' },
      autoDeclinedIds: conflicts.map((conflict) => conflict.id),
    });
  }

  decline(
    bookingId: string,
    ownerId: string,
    now: Date,
  ): Promise<BookingRecord | null> {
    const booking = this.bookings.find(
      (row) => row.id === bookingId && this.owners.get(row.listingId) === ownerId,
    );
    if (booking === undefined) return Promise.resolve(null);

    if (booking.state !== 'REQUESTED') {
      return Promise.reject(new BookingStateChangedError(bookingId, booking.state));
    }

    // Deliberately no deadline check, matching the real store: saying no after
    // the deadline costs a renter nothing they had not already lost.
    void now;

    this.replace(booking, 'DECLINED');
    this.record(booking.id, 'state-changed', 'REQUESTED', 'DECLINED', ownerId, {});

    return Promise.resolve({ ...booking, state: 'DECLINED' });
  }

  /**
   * One booking, one edge (slice 5.2c).
   *
   * **The `from` state is part of the match, not checked after it.** The real
   * store puts it in the `UPDATE`'s `where`, so a booking that has already moved
   * is simply not matched — and a double that read the row, compared, then wrote
   * would let two racing callers both apply. Modelling the predicate is what makes
   * a service test evidence of anything.
   */
  advance(transition: {
    readonly bookingId: string;
    readonly from: BookingState;
    readonly to: BookingState;
    readonly actorId: string | null;
    readonly now: Date;
  }): Promise<BookingRecord | null> {
    const { bookingId, from, to, actorId } = transition;

    const booking = this.bookings.find((candidate) => candidate.id === bookingId);
    if (booking === undefined || booking.state !== from) return Promise.resolve(null);

    this.replace(booking, to);
    this.record(bookingId, 'state-changed', from, to, actorId, {});

    return Promise.resolve({ ...booking, state: to });
  }

  /**
   * The expiry sweep (slice 4.7a).
   *
   * **The ordering and the bound are modelled; the race is not.** What the real
   * store guarantees is that the state predicate is evaluated under the row lock,
   * so a booking accepted between the read and the write is not expired — and only
   * `prisma-booking-store.db.test.ts` can be evidence of that. In memory there is
   * nothing between the two, which is the same division every fake here draws.
   */
  expireRequests(now: Date, limit: number): Promise<ExpirySweepResult> {
    const candidates = this.bookings
      .filter((row) => row.state === 'REQUESTED' && row.requestExpiresAt <= now)
      .sort(
        (a, b) =>
          a.requestExpiresAt.getTime() - b.requestExpiresAt.getTime() ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);

    const expired = candidates.map((booking) => {
      this.replace(booking, 'EXPIRED');
      this.record(booking.id, 'state-changed', 'REQUESTED', 'EXPIRED', null, {});
      return {
        id: booking.id,
        renterId: booking.renterId,
        listingId: booking.listingId,
      };
    });

    return Promise.resolve({ expired, reachedLimit: candidates.length === limit });
  }

  /** Move a booking to a new state in place, keeping the array identity stable. */
  private replace(booking: BookingRecord, state: BookingState): void {
    const at = this.bookings.indexOf(booking);
    this.bookings[at] = { ...booking, state, updatedAt: this.now() };
  }

  private record(
    bookingId: string,
    type: BookingEventType,
    fromState: BookingState | null,
    toState: BookingState | null,
    actorId: string | null,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    this.events.push({
      bookingId,
      type,
      fromState,
      toState,
      actorId,
      metadata,
      id: `event-${String(this.events.length + 1)}`,
      createdAt: this.now(),
    });
  }

  findForRenter(renterId: string, limit: number): Promise<readonly BookingRecord[]> {
    return Promise.resolve(this.newestFirst((row) => row.renterId === renterId, limit));
  }

  findForOwner(ownerId: string, limit: number): Promise<readonly BookingRecord[]> {
    return Promise.resolve(
      this.newestFirst((row) => this.owners.get(row.listingId) === ownerId, limit),
    );
  }

  /**
   * The shared half of the two list reads (slice 4.8a).
   *
   * **The `id` tiebreak is reproduced rather than left to the array order**, and
   * it is the whole reason this helper exists: the real query orders by
   * `createdAt desc, id desc`, and a fake that returned insertion order would let
   * a test pass while the database returned something else. This store stamps
   * every row from one injected clock, so same-millisecond ties are the *normal*
   * case here rather than the rare one — the opposite of production, which is
   * exactly when a fake is most likely to disagree.
   */
  private newestFirst(
    matches: (row: BookingRecord) => boolean,
    limit: number,
  ): readonly BookingRecord[] {
    return this.bookings
      .filter(matches)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )
      .slice(0, limit);
  }

  findForParty(id: string, userId: string): Promise<BookingWithEvents | null> {
    const booking = this.bookings.find(
      (candidate) =>
        candidate.id === id &&
        (candidate.renterId === userId ||
          this.owners.get(candidate.listingId) === userId),
    );
    if (booking === undefined) return Promise.resolve(null);

    return Promise.resolve({
      booking,
      /*
       * **A fixed breakdown rather than the quote's.** The real store joins the
       * quote the booking was made from; this fake holds no quotes, and inventing
       * a plausible one would let a test assert a breakdown that never came from
       * a price anybody was shown. One line item, obviously synthetic, is enough
       * for a service test about refusals — the round trip is the db test's
       * subject.
       */
      lineItems: [
        {
          unit: 'day',
          count: 1,
          unitPrice: booking.itemCharge,
          subtotal: booking.itemCharge,
        },
      ],
      events: this.events
        .filter((event) => event.bookingId === booking.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    });
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

  /** Whether a calendar-occupying booking holds any of this period. */
  occupies(listingId: string, startAt: Date, endAt: Date): boolean {
    return this.bookings.some(
      (existing) =>
        existing.listingId === listingId &&
        CALENDAR_OCCUPYING_STATES.includes(existing.state) &&
        existing.startAt < endAt &&
        existing.endAt > startAt,
    );
  }

  /**
   * The calendar-occupying bookings touching this window (slice 4.8c).
   *
   * **The same two conditions `occupies` applies**, returning the rows rather
   * than a boolean — and written as those conditions rather than as a general
   * "does this clash" for the reason `create` gives: a fake that was more
   * permissive would let the calendar pass while the database drew something
   * else, and a stricter one would make a legitimate back-to-back hire look
   * broken in tests only.
   */
  occupying(listingId: string, from: Date, to: Date): readonly BookingRecord[] {
    return this.bookings
      .filter(
        (existing) =>
          existing.listingId === listingId &&
          CALENDAR_OCCUPYING_STATES.includes(existing.state) &&
          existing.startAt < to &&
          existing.endAt > from,
      )
      .sort(
        (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
      );
  }

  /**
   * Put a booking in without going through `create`, for the erasure tests.
   *
   * **It skips the overlap check deliberately.** Those tests are about which
   * listings are *referenced*, and making them construct a non-conflicting
   * period would be arranging around a rule they are not testing.
   */
  holds(
    listingId: string,
    /**
     * The state and period, for callers that care (slice 4.8c).
     *
     * **Widened rather than copied.** The calendar's booked layer needs a booking
     * in a *named* state over a *named* period — which is what its whole rule is
     * about, since §7.1 keeps `REQUESTED` off the calendar — and a second helper
     * beside this one would be two places that decide what a synthetic booking
     * looks like. The defaults are unchanged, so every existing caller is too.
     */
    over: Partial<Pick<BookingRecord, 'state' | 'startAt' | 'endAt'>> = {},
  ): this {
    const now = this.now();
    const startAt = over.startAt ?? now;
    this.bookings.push({
      id: `booking-${String(this.nextId++)}`,
      listingId,
      renterId: 'renter',
      state: over.state ?? 'REQUESTED',
      startAt,
      endAt: over.endAt ?? Time.addRentalDays(startAt, 1, 'Europe/London'),
      timeZone: 'Europe/London',
      // The terms slice 4.5a made required. Obviously synthetic, because these
      // tests are about which listings are referenced and nothing reads a price.
      quoteId: 'quote-erasure-fixture',
      categoryVersionId: 'category-version-erasure-fixture',
      itemCharge: { amount: 1_800, currency: 'GBP' },
      renterFee: { amount: 144, currency: 'GBP' },
      total: { amount: 1_944, currency: 'GBP' },
      itemTitle: 'Petrol hedge trimmer',
      categoryName: 'Outdoor and gardening',
      // Null, like the rest of these terms: this fixture exists for erasure
      // tests, which are about which listings a booking references.
      appliedExcess: null,
      requestExpiresAt: Time.addHours(now, 48),
      createdAt: now,
      updatedAt: now,
    });
    return this;
  }
}

/**
 * The owner's calendar without a database (slice 4.3a).
 *
 * **It reproduces the rule and not the storage**, which here is nearly all of
 * it: the overlap arithmetic is two comparisons in the real adapter too, so a
 * test against this and a test against Postgres are asking the same question of
 * the same logic. What only the db test can show is that the trigger's `[)` and
 * `overlaps`' `<`/`>` agree — the two places the bound is stated.
 */
export class InMemoryAvailabilityStore implements AvailabilityStore {
  private readonly blocks: AvailabilityBlockRecord[] = [];
  private nextId = 1;

  constructor(private readonly bookings: InMemoryBookingStore) {}

  block(block: NewAvailabilityBlock): Promise<AvailabilityBlockRecord> {
    const record: AvailabilityBlockRecord = {
      ...block,
      id: `block-${String(this.nextId++)}`,
    };
    this.blocks.push(record);
    return Promise.resolve(record);
  }

  unblock(id: string, listingId: string): Promise<boolean> {
    const index = this.blocks.findIndex(
      (block) => block.id === id && block.listingId === listingId,
    );
    if (index === -1) return Promise.resolve(false);

    this.blocks.splice(index, 1);
    return Promise.resolve(true);
  }

  listBlocks(
    listingId: string,
    from: Date,
    to: Date,
  ): Promise<readonly AvailabilityBlockRecord[]> {
    return Promise.resolve(
      this.blocks
        .filter(
          (block) =>
            block.listingId === listingId && block.startAt < to && block.endAt > from,
        )
        .sort(
          (a, b) =>
            a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
        ),
    );
  }

  listBookedPeriods(
    listingId: string,
    from: Date,
    to: Date,
  ): Promise<readonly BookedPeriodRecord[]> {
    return Promise.resolve(
      this.bookings.occupying(listingId, from, to).map((booking) => ({
        id: booking.id,
        startAt: booking.startAt,
        endAt: booking.endAt,
      })),
    );
  }

  reasonUnavailable(
    listingId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<UnavailableReason | null> {
    // Blocked before booked, mirroring the adapter — the owner is told the
    // thing they can change.
    const blocked = this.blocks.some(
      (block) =>
        block.listingId === listingId && block.startAt < endAt && block.endAt > startAt,
    );
    if (blocked) return Promise.resolve('blocked');

    return Promise.resolve(
      this.bookings.occupies(listingId, startAt, endAt) ? 'booked' : null,
    );
  }
}

/**
 * Who owns what, without Catalogue (slice 4.3b).
 *
 * **The port Booking declares, doubled here rather than in Catalogue's fakes**,
 * because it belongs to whoever states the interface — a test of the calendar
 * should not have to build a listing store, a category service and a geocoder
 * to say "this listing is Ada's".
 *
 * It is deliberately a set of pairs and not a listing: the real answer is a
 * boolean, so a double that held records would let a test reach for a field the
 * production code cannot see.
 */
/**
 * Quotes without a database (slice 4.4b).
 *
 * **It stores what it is given and answers what it stored.** There is no
 * arithmetic here — the pricing is pure and is tested directly in
 * `rental-quote.test.ts` — so unlike `InMemoryBookingStore` this fake models no
 * rule and can therefore misrepresent none. What it substitutes for is a round
 * trip, which is what makes a service test about refusals rather than about
 * Prisma.
 *
 * **The `jsonb` round trip is the one thing it cannot exhibit**, and
 * `prisma-quote-store.db.test.ts` is where the line items are proved to survive
 * it.
 */
export class InMemoryQuoteStore implements QuoteStore {
  private readonly quotes: QuoteRecord[] = [];
  private nextId = 1;

  create(quote: NewQuote): Promise<QuoteRecord> {
    const record: QuoteRecord = {
      ...quote,
      id: `quote-${String(this.nextId++)}`,
      // `Time.nowUtc()` rather than `new Date()`, which the lint rule refuses
      // across `apps/api` — see `InMemoryBookingStore` for ADR 0003's reasoning.
      createdAt: Time.nowUtc(),
    };
    this.quotes.push(record);
    return Promise.resolve(record);
  }

  findForRenter(id: string, renterId: string): Promise<QuoteRecord | null> {
    return Promise.resolve(
      this.quotes.find((quote) => quote.id === id && quote.renterId === renterId) ??
        null,
    );
  }

  /**
   * Erase the quotes nothing has booked (slice 4.5a).
   *
   * **The fake has to be told which quotes are booked**, because it holds no
   * bookings — `bookedQuoteIds` is what a test states. Inferring it would be the
   * fake deciding a rule the real query decides, which is how a double comes to
   * pass a test the database would fail.
   */
  bookedQuoteIds = new Set<string>();

  listUnbookedForRenter(
    renterId: string,
    limit: number,
  ): Promise<readonly ExportableQuote[]> {
    /*
     * **The same two conditions `deleteUnbookedForRenter` applies**, written the
     * same way rather than as a general "is this exportable" — the export is a
     * mirror of the erasure, and a fake that disagreed with its own delete would
     * let a test prove the mirror while the real pair had drifted.
     *
     * **The title is synthetic**, because this store holds no listings. What a
     * test can assert here is *which* quotes appear and what the postcode is; the
     * join is the db test's subject.
     */
    return Promise.resolve(
      this.quotes
        .filter(
          (quote) => quote.renterId === renterId && !this.bookedQuoteIds.has(quote.id),
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
        )
        .slice(0, limit)
        .map((quote) => ({
          id: quote.id,
          startAt: quote.startAt,
          endAt: quote.endAt,
          itemTitle: 'Petrol hedge trimmer',
          total: quote.total,
          renterPostcode: quote.renterPostcode,
          createdAt: quote.createdAt,
          expiresAt: quote.expiresAt,
        })),
    );
  }

  postcodesFor(
    quoteIds: readonly string[],
    renterId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const wanted = new Set(quoteIds);

    return Promise.resolve(
      new Map(
        this.quotes
          // Renter-scoped as well as id-scoped, mirroring the real query: without
          // it a test could pass while the adapter handed out somebody else's
          // postcode.
          .filter((quote) => wanted.has(quote.id) && quote.renterId === renterId)
          .map((quote) => [quote.id, quote.renterPostcode] as const),
      ),
    );
  }

  deleteUnbookedForRenter(renterId: string): Promise<number> {
    const before = this.quotes.length;
    // Spliced in place rather than reassigned, so a caller holding this instance
    // sees the erasure — the same reason the array is `readonly`.
    for (let index = this.quotes.length - 1; index >= 0; index -= 1) {
      const quote = this.quotes[index];
      if (quote?.renterId === renterId && !this.bookedQuoteIds.has(quote.id)) {
        this.quotes.splice(index, 1);
      }
    }
    return Promise.resolve(before - this.quotes.length);
  }

  /** What is stored, for a test that needs to look. */
  all(): readonly QuoteRecord[] {
    return this.quotes;
  }
}

/**
 * The listing facts a quote needs, stated in one line by a test (slice 4.4b).
 *
 * The port Catalogue answers in production. Here so a pricing test can say *"this
 * listing costs £18 a day and its category allows 88 days"* without a category, a
 * version, an owner declaration or a database.
 */
export class InMemoryListingQuoteSource implements ListingQuoteSource {
  private readonly listings = new Map<string, QuotableListing>();

  /** Record a listing a renter could book. Returns `this` so calls chain. */
  give(listing: QuotableListing): this {
    this.listings.set(listing.id, listing);
    return this;
  }

  findQuotable(listingId: string): Promise<QuotableListing | null> {
    return Promise.resolve(this.listings.get(listingId) ?? null);
  }
}

export class InMemoryListingOwnership implements ListingOwnership {
  /*
   * **`\0` as the separator, written as an escape rather than as the character
   * itself.** It was a literal NUL byte until slice 4.7a, which is the same
   * character to JavaScript and had one invisible cost: two NULs made git treat
   * this whole file as **binary**, so every diff to it read `Bin 41293 -> 42871`
   * and no change to any fake in here could be reviewed. Found by noticing that
   * `grep` called it a binary file.
   *
   * The separator itself is right and stays: a key built by joining two ids needs a
   * byte neither can contain, and a uuid cannot contain this one.
   */
  private readonly owned = new Set<string>();

  /** Record that this listing is this owner's. */
  give(listingId: string, ownerId: string): this {
    this.owned.add(`${ownerId}\0${listingId}`);
    return this;
  }

  isOwnedBy(listingId: string, ownerId: string): Promise<boolean> {
    return Promise.resolve(this.owned.has(`${ownerId}\0${listingId}`));
  }

  ownerOf(listingId: string): Promise<string | null> {
    for (const entry of this.owned) {
      const [ownerId, owned] = entry.split('\0');
      if (owned === listingId) return Promise.resolve(ownerId ?? null);
    }
    return Promise.resolve(null);
  }
}

/**
 * The whole module's fakes, in one call — the shape every other module's
 * `testing/fakes.ts` offers, so a composition root in a test reads the same way
 * whichever module it is wiring.
 */
/**
 * The charge, as Booking asks for it (slice 5.2c).
 *
 * **A fake of Booking's own port, not of `PaymentsService`.** What Booking's
 * tests are about is where a booking ends up given an answer; whether that answer
 * is right is proved in `payments.service.test.ts` against the real ledger fake.
 * Faking the port keeps the two suites from testing each other.
 *
 * **It records what it was asked**, because several rules here are about *not*
 * charging — a booking in the wrong state, a payment switched off, an owner
 * pressing pay — and the only way to assert that is to count.
 */
export class RecordingHirePayments implements HirePayments {
  readonly requests: HireChargeRequest[] = [];

  private next: HireChargeResult = { status: 'succeeded' };

  /** Change what the next charge reports — a challenge, a wait, a decline. */
  willReport(result: HireChargeResult): void {
    this.next = result;
  }

  chargeForHire(request: HireChargeRequest): Promise<HireChargeResult> {
    this.requests.push(request);
    return Promise.resolve(this.next);
  }
}

/**
 * §8.7.2's hold at the collection window, as Booking sees it (slice 5.5c-ii).
 *
 * **Its own fake beside `RecordingHirePayments` rather than a method on it**, so
 * a test can assert that securing a handover charged nobody, and that paying held
 * nothing. One fake with two lists would make each of those a filter, and a filter
 * that is wrong reads as a pass.
 *
 * **It defaults to `held`, not `not_required`.** The default is the case that
 * exercises the most code; `not_required` short-circuits before the interesting
 * part and would let a broken flow look green.
 */
export class RecordingCollectionSecurity implements CollectionSecurity {
  readonly requests: CollectionSecurityRequest[] = [];

  private next: CollectionSecurityResult = { status: 'held' };

  /** Change what the next hold reports — a challenge, a refusal, nothing to hold. */
  willReport(result: CollectionSecurityResult): void {
    this.next = result;
  }

  holdForCollection(
    request: CollectionSecurityRequest,
  ): Promise<CollectionSecurityResult> {
    this.requests.push(request);
    return Promise.resolve(this.next);
  }
}

export function createBookingFakes(
  /**
   * The clock the calendar service reads, for the two refusals that need to
   * know what today is (slice 4.3b). Defaults to the real one, so a caller that
   * does not care about dates in the past need not think about it.
   */
  now: () => Date = Time.nowUtc,
): {
  readonly store: InMemoryBookingStore;
  readonly availability: InMemoryAvailabilityStore;
  readonly ownership: InMemoryListingOwnership;
  readonly service: AvailabilityService;
  readonly references: { findBookedListings: BookingStore['findBookedListings'] };
  readonly quoteStore: InMemoryQuoteStore;
  readonly quotableListings: InMemoryListingQuoteSource;
  readonly quotes: QuotesService;
  readonly bookings: BookingsService;
  readonly requestExpiry: RequestExpiryService;
  /** What the charge reports next, and what it was asked (slice 5.2c). */
  readonly payments: RecordingHirePayments;
  /** What the hold reports next, and what it was asked (slice 5.5c-ii). */
  readonly security: RecordingCollectionSecurity;
  /** Flip to prove the refusal when payment is switched off (slice 5.2c). */
  readonly paymentsEnabled: { value: boolean };
} {
  const store = new InMemoryBookingStore(now);
  // Built over the same booking store, because "booked" is not a second fact
  // — a calendar reading a different set of bookings than the one that
  // enforces the overlap is a calendar that lies.
  const availability = new InMemoryAvailabilityStore(store);
  // The port Catalogue answers in production (slice 4.3b). Here so a calendar
  // test can state ownership in one line and never touch a listing.
  const ownership = new InMemoryListingOwnership();
  const quoteStore = new InMemoryQuoteStore();
  const quotableListings = new InMemoryListingQuoteSource();
  const payments = new RecordingHirePayments();
  const security = new RecordingCollectionSecurity();
  /*
   * A box rather than a boolean, so a test can flip it *after* the service has
   * been constructed — the service holds the port, not the value.
   */
  const paymentsEnabled = { value: true };

  return {
    payments,
    security,
    paymentsEnabled,
    store,
    ownership,
    availability,
    quoteStore,
    quotableListings,
    /*
     * **The quote engine over the same fake calendar**, for the reason the
     * availability service is built over the same booking store: a quote that
     * consulted a different set of blocked dates than the calendar shows would
     * be a quote for dates the owner has already refused.
     */
    quotes: new QuotesService(quoteStore, quotableListings, availability, now),
    /*
     * **The request path over the same store, the same listings and the same
     * calendar** (slice 4.5a). A request is made from a quote, so a second quote
     * store here would let a test create a quote the request path cannot see.
     */
    bookings: new BookingsService(
      store,
      quoteStore,
      quotableListings,
      availability,
      /*
       * **Paying, answered by a fake provider that succeeds** (slice 5.2c). An
       * integration test asserting the route, the codes and the permissions has
       * to get past the charge, and what happens *inside* Payments is proved
       * against real fakes in `payments.service.test.ts`.
       */
      payments,
      ownership,
      /*
       * **On, unlike production.** `booking.payment` defaults off because there is
       * no provider adapter yet; a test of the paying route would otherwise only
       * ever prove the refusal. The refusal has its own test that switches this
       * off, so both paths are covered rather than one.
       */
      { isPaymentEnabled: () => Promise.resolve(paymentsEnabled.value) },
      security,
      now,
    ),
    /*
     * **The sweep over the same store** (slice 4.7a), so a test can expire a
     * request the request path created and then read the history back through
     * `findForParty`. A second store here would expire rows nothing else can see.
     *
     * A recording logger rather than a shared silent one: what a sweep logs is
     * asserted in `request-expiry.service.test.ts`, and this instance exists only
     * so the service has somewhere to write.
     */
    requestExpiry: new RequestExpiryService(store, createRecordingLogger().logger, now),
    /*
     * **The real service over fake storage**, which is the arrangement
     * `createListingFakes` uses and for the same reason: what an integration
     * test is exercising is the routing, the guard and the conversion between
     * dates and instants, none of which a stubbed service would run.
     */
    service: new AvailabilityService(availability, ownership, now),
    // The narrowed view Catalogue declares, built here rather than at each call
    // site so the boundary is stated once — the same arrangement `main.ts` uses
    // for `ListingProximity`.
    references: { findBookedListings: (ids) => store.findBookedListings(ids) },
  };
}

/**
 * The Booking module's slice of `AppModuleOptions`, for a test that boots the
 * whole application and has no interest in bookings (slice 4.4b).
 *
 * **It exists because `AppModuleOptions` makes every dependency required**, which
 * is deliberate — an optional one is what ten boot sites forget — and the cost is
 * that adding a service to this module edits five test files that do not use it.
 * One spread absorbs that: `4.5` adds a field here and nowhere else.
 *
 * The instances are real services over in-memory storage, so the routing, the
 * guard and the date conversion all still run.
 */
export function bookingModuleFakes(): {
  readonly availability: AvailabilityService;
  readonly quotes: QuotesService;
  readonly bookings: BookingsService;
  readonly requestExpiry: RequestExpiryService;
  readonly reconciliation: ReconciliationService;
  readonly internalTriggerSecret: string;
} {
  const fakes = createBookingFakes();

  return {
    availability: fakes.service,
    quotes: fakes.quotes,
    bookings: fakes.bookings,
    requestExpiry: fakes.requestExpiry,
    /*
     * **Payments', not Booking's, and spread in from that module's own helper**
     * (slice 5.4a). The alternative was constructing it here, which would have put
     * a ledger and a payment provider inside a file about bookings.
     *
     * **This helper has now outgrown its name**, which is worth saying rather than
     * hiding: it is *the slice of `AppModuleOptions` a test with no interest in any
     * of it still has to supply*, and it already carried `internalTriggerSecret` on
     * the same reasoning. If a third module needs one, rename it rather than adding
     * a third exception.
     */
    ...paymentsModuleFakes(),
    /*
     * **Not a Booking service, and it still belongs here** (slice 4.7a). It is
     * part of this module's slice of `AppModuleOptions` — the guard that reads it
     * lives in `booking/` — and the whole promise of this helper is that a new
     * field is added in one place rather than at every boot site.
     */
    internalTriggerSecret: TEST_INTERNAL_TRIGGER_SECRET,
  };
}

/**
 * The internal-trigger secret the tests use (slice 4.7a).
 *
 * Exported so a test can present the **right** one as well as a wrong one: a guard
 * proved only by refusing is a guard that might be refusing everything.
 *
 * Longer than the environment schema's 32-character floor, and obviously fake so it
 * can never be mistaken for one somebody generated.
 *
 * **It begins with `example-` to satisfy `.gitleaks.toml`, not for readability.** The
 * `generic-secret-assignment` rule fires on any `secret = "<16+ chars>"` and allows
 * values containing `example`, `placeholder` and a few others. This value previously
 * began `test-` and passed the scan **only because Prettier had wrapped the literal
 * onto its own line** — gitleaks matches per line, so the assignment and the value
 * were never on one. That is a scan passing by accident of formatting, and a
 * reflow would have broken the push.
 */
export const TEST_INTERNAL_TRIGGER_SECRET =
  'example-internal-trigger-secret-not-a-real-one';
