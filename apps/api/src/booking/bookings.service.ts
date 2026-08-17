import { Time } from '@platform/core';
import type { Booking, BookingRequest } from '@platform/contracts';
import { rentalPeriodDays } from '../pricing/rental-period.js';
import type { AvailabilityStore, UnavailableReason } from './availability-store.js';
import { assertTransition } from './booking-state-machine.js';
import { OverlappingBookingError } from './booking-store.js';
import type { BookingStore, BookingWithEvents } from './booking-store.js';
import type { ListingQuoteSource } from './listing-quote-source.js';
import type { QuoteStore } from './quote-store.js';

/**
 * Making a booking request (BRD §8.6, §7, slice 4.5a).
 *
 * **This is the first thing in the project that makes something bookable.**
 * Everything before it described, found, priced or blocked; this writes a row two
 * people are bound by.
 *
 * ## Where a booking starts, and the state it never enters
 *
 * **A booking is created directly in `REQUESTED`, never in `DRAFT`.** §7 has
 * `DRAFT → REQUESTED` and `DRAFT → ABANDONED`, which together model a booking
 * somebody began and did not submit — and **the quote already is that artefact.**
 * It is persisted, it belongs to the renter, and it expires, which is precisely
 * what `DRAFT → ABANDONED` would express. Creating a `DRAFT` row and transitioning
 * out of it in the same transaction would be a state no human ever sees and a
 * history entry that records nothing.
 *
 * So **nothing enters `DRAFT` today**, deliberately, and `booking-state-machine.ts`
 * still holds its edges because §7 does. A later multi-step request flow — one
 * where a renter answers questions across several screens — is the thing that
 * would use it, and it should do so on purpose.
 *
 * **The transition is still asserted rather than assumed.** `assertTransition` is
 * called for the creation even though there is no prior state, because §7 opens by
 * saying transitions are validated centrally and *"UI buttons must never directly
 * invent transitions"* — and the first one is the easiest to invent.
 *
 * ## The refusals, in the order they run
 *
 * 1. **Is this the renter's own quote?** Not theirs is a 404, indistinguishable
 *    from a quote that does not exist.
 * 2. **Has the price expired?** §8.5.2 gives a quote an expiry; a booking built on
 *    a stale one would bind somebody to a figure we withdrew.
 * 3. **Is the listing still bookable, and still not their own?** Both were true
 *    when the quote was issued and either can have changed since — a listing can
 *    be paused, hidden or repriced in the thirty minutes a quote lives.
 * 4. **Are the dates still free?** The blocked-dates check the phase handoff
 *    names, because `EXCLUDE` cannot span two tables.
 * 5. **Did somebody else get there first?** That one is the database's, and it is
 *    deliberately not pre-empted — §8.5.1 names check-then-insert as the
 *    anti-pattern by name.
 */
export class BookingsService {
  constructor(
    private readonly bookings: BookingStore,
    private readonly quotes: QuoteStore,
    /** What the item is and what its category permits, answered by Catalogue. */
    private readonly listings: ListingQuoteSource,
    /**
     * Whether the dates are still free.
     *
     * **The store rather than `AvailabilityService`**, for the reason
     * `QuotesService` gives: every method on that service is owner-scoped, and a
     * renter making a request owns nothing.
     */
    private readonly availability: AvailabilityStore,
    /** Injected so the expiry refusals are provable without waiting (ADR 0003). */
    private readonly now: () => Date = Time.nowUtc,
  ) {}

  /**
   * Submit a request, or refuse it.
   *
   * Resolves to null when the quote is not this renter's or does not exist — the
   * route answers 404 and cannot tell the two apart.
   *
   * Throws {@link RequestRefusedError} when the request cannot be made for a
   * reason the renter can act on, and `OverlappingBookingError` when somebody else
   * booked the dates first. The second is deliberately *not* translated here: 4.6
   * has to tell a lost race apart from a refusal, because §7.1 auto-declines the
   * loser rather than arguing with them.
   */
  async request(renterId: string, request: BookingRequest): Promise<Booking | null> {
    const quote = await this.quotes.findForRenter(request.quoteId, renterId);
    if (quote === null) return null;

    if (quote.expiresAt.getTime() <= this.now().getTime()) {
      /*
       * **A refusal rather than a silent re-price.** Re-quoting behind the
       * renter's back would bind them to a number they never saw, which is
       * exactly what §3.4.4 exists to prevent — and the new figure might be
       * higher. They are told, and the page asks again.
       */
      throw new RequestRefusedError(
        'That price has expired. Ask for the dates again and you will get a fresh ' +
          'quote — the price may have changed.',
      );
    }

    const listing = await this.listings.findQuotable(quote.listingId);
    if (listing === null) {
      /*
       * **Re-checked, because a quote outlives the facts it was built on.** A
       * listing can be paused by its owner or hidden by the platform inside the
       * thirty minutes a quote lives, and a booking made against one would be a
       * commitment to something nobody can supply.
       */
      throw new RequestRefusedError(
        'This item is no longer available to book. It may have been withdrawn since ' +
          'you asked for a price.',
      );
    }

    if (listing.ownerId === renterId) {
      throw new RequestRefusedError(
        'This is your own listing, so there is nothing to request.',
      );
    }

    const unavailable = await this.availability.reasonUnavailable(
      quote.listingId,
      quote.startAt,
      quote.endAt,
    );
    if (unavailable !== null)
      throw new RequestRefusedError(describeUnavailable(unavailable));

    /*
     * **Asserted rather than written**, even though there is no prior state. §7:
     * transitions are validated centrally and a button must never invent one. The
     * first state is the one most easily invented, and this is the line that makes
     * inventing it impossible.
     */
    const state = assertTransition('DRAFT', 'REQUESTED');

    const created = await this.bookings.createWithEvent(
      {
        listingId: quote.listingId,
        renterId,
        state,
        startAt: quote.startAt,
        endAt: quote.endAt,
        timeZone: quote.timeZone,
        quoteId: quote.id,
        /*
         * **Every term comes off the quote, in one place, here.** §8.2 requires a
         * booking to keep the terms it was made under, and the product owner's
         * instruction of 16 August is that a finished booking shows all its
         * details — so nothing downstream reads a price through the listing.
         *
         * The category version comes off the quote too rather than being
         * re-resolved from the listing, and that matters: re-resolving would pin
         * whatever is current *now*, which may not be what the renter was quoted
         * under if the category was reconfigured in the last half hour.
         */
        categoryVersionId: quote.categoryVersionId,
        itemCharge: quote.itemCharge,
        renterFee: quote.renterFee,
        total: quote.total,
        itemTitle: listing.title,
        categoryName: listing.categoryName,
        requestExpiresAt: this.requestDeadline(listing.currentRequestExpiryHours),
      },
      {
        type: 'requested',
        /*
         * **Null, not `DRAFT`.** The booking was never in `DRAFT` — see the class
         * docblock — and recording it would put a state in the history that never
         * happened.
         */
        fromState: null,
        toState: state,
        actorId: renterId,
        metadata: {},
      },
    );

    const withEvents = await this.bookings.findForParty(created.id, renterId);
    /* c8 ignore next -- unreachable: we created it and we are its renter. */
    if (withEvents === null)
      throw new Error('a booking vanished between write and read');

    return toWireBooking(withEvents);
  }

  /**
   * One booking, as either party reads it.
   *
   * Null for "no such booking" and for "not yours", which the route answers 404
   * to — the rule every scoped read in this project follows.
   */
  async find(id: string, userId: string): Promise<Booking | null> {
    const found = await this.bookings.findForParty(id, userId);

    return found === null ? null : toWireBooking(found);
  }

  /**
   * When an unanswered request runs out (§8.6).
   *
   * **Computed from the category's configured hours at the moment of the request**,
   * so a deadline an administrator changes tomorrow cannot move a request made
   * today. That is the same reasoning the quote's own expiry and the pinned fee
   * policy both use.
   */
  private requestDeadline(hours: number): Date {
    return Time.addHours(this.now(), hours);
  }
}

/**
 * A request we will not accept, with the sentence the renter reads.
 *
 * Carries the words rather than a code, matching `QuoteRefusedError` and
 * `BlockRefusedError` beside it: the refusal is decided where the rule is.
 */
export class RequestRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = 'RequestRefusedError';
  }
}

/**
 * Why the dates are gone, as a renter may be told it.
 *
 * The same sentence for both reasons, and for the reason `QuotesService` gives at
 * length: an owner's note is their own business. Switched exhaustively so a third
 * reason cannot inherit wording written for these two.
 */
function describeUnavailable(reason: UnavailableReason): string {
  switch (reason) {
    case 'blocked':
    case 'booked':
      return (
        'Those dates have been taken since you asked for a price. The calendar on ' +
        'the listing shows what is free.'
      );
  }
}

/** A stored booking and its history as the wire projection. */
function toWireBooking({ booking, lineItems, events }: BookingWithEvents): Booking {
  return {
    id: booking.id,
    listingId: booking.listingId,
    state: booking.state,
    startDate: Time.toLocalDateString(booking.startAt),
    // Back to the inclusive last day the renter asked for — the mirror of
    // `local-period.ts`, and the same conversion `toWireQuote` performs.
    endDate: Time.addLocalDays(Time.toLocalDateString(booking.endAt), -1),
    days: rentalPeriodDays(booking.startAt, booking.endAt, booking.timeZone),
    itemTitle: booking.itemTitle,
    categoryName: booking.categoryName,
    itemCharge: booking.itemCharge,
    renterFee: booking.renterFee,
    total: booking.total,
    lineItems: [...lineItems],
    requestExpiresAt: Time.toIsoUtc(booking.requestExpiresAt),
    events: events.map((event) => ({
      type: event.type,
      fromState: event.fromState,
      toState: event.toState,
      at: Time.toIsoUtc(event.createdAt),
    })),
  };
}

export { OverlappingBookingError };
