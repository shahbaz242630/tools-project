import { Time } from '@platform/core';
import { CALENDAR_OCCUPYING_STATES } from '../booking-state-machine.js';
import { OverlappingBookingError } from '../booking-store.js';
import type {
  BookingEventRecord,
  BookingRecord,
  BookingStore,
  BookingWithEvents,
  NewBooking,
  NewBookingEvent,
} from '../booking-store.js';
import type {
  AvailabilityBlockRecord,
  AvailabilityStore,
  NewAvailabilityBlock,
  UnavailableReason,
} from '../availability-store.js';
import type { ListingOwnership } from '../listing-ownership.js';
import type { ListingQuoteSource, QuotableListing } from '../listing-quote-source.js';
import type { NewQuote, QuoteRecord, QuoteStore } from '../quote-store.js';
import { AvailabilityService } from '../availability.service.js';
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
   * Put a booking in without going through `create`, for the erasure tests.
   *
   * **It skips the overlap check deliberately.** Those tests are about which
   * listings are *referenced*, and making them construct a non-conflicting
   * period would be arranging around a rule they are not testing.
   */
  holds(listingId: string): this {
    const now = this.now();
    this.bookings.push({
      id: `booking-${String(this.nextId++)}`,
      listingId,
      renterId: 'renter',
      state: 'REQUESTED',
      startAt: now,
      endAt: Time.addRentalDays(now, 1, 'Europe/London'),
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
  private readonly owned = new Set<string>();

  /** Record that this listing is this owner's. */
  give(listingId: string, ownerId: string): this {
    this.owned.add(`${ownerId} ${listingId}`);
    return this;
  }

  isOwnedBy(listingId: string, ownerId: string): Promise<boolean> {
    return Promise.resolve(this.owned.has(`${ownerId} ${listingId}`));
  }
}

/**
 * The whole module's fakes, in one call — the shape every other module's
 * `testing/fakes.ts` offers, so a composition root in a test reads the same way
 * whichever module it is wiring.
 */
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

  return {
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
      now,
    ),
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
} {
  const fakes = createBookingFakes();

  return {
    availability: fakes.service,
    quotes: fakes.quotes,
    bookings: fakes.bookings,
  };
}
