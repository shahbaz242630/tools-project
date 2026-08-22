import { Paging, Time } from '@platform/core';
import type {
  Booking,
  BookingDetail,
  BookingPayment,
  BookingRequest,
  BookingState,
  BookingSummaries,
  BookingSummary,
  ListingRequest,
  ListingRequests,
  OwnerBookings,
  OwnerBookingSummary,
} from '@platform/contracts';
import { rentalPeriodDays } from '../pricing/rental-period.js';
import type { AvailabilityStore, UnavailableReason } from './availability-store.js';
import { assertTransition } from './booking-state-machine.js';
import {
  DuplicateQuoteBookingError,
  OverlappingBookingError,
} from './booking-store.js';
import type {
  BookingRecord,
  BookingStore,
  BookingWithEvents,
  PendingRequest,
} from './booking-store.js';
import type { HireChargeResult, HirePayments } from './hire-payments.js';
import {
  PAYABLE_STATES,
  PAYMENT_NOT_ENABLED,
  describeUnpayable,
  payabilityOf,
} from './payability.js';
import type { PaymentSwitch } from './payment-switch.js';
import type { ListingOwnership } from './listing-ownership.js';
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
/**
 * Who is reading a booking, for the parts of the answer that depend on them
 * (slice 5.2d).
 *
 * **An object with one field rather than a bare boolean parameter**, so a call
 * site says `{ isSuspended: false }` and cannot be read as the id beside it. It
 * has no default, deliberately: a caller that forgot it would silently claim the
 * reader is in good standing, and the failure would be a live pay button that
 * answers 403.
 */
export interface BookingReader {
  readonly isSuspended: boolean;
}

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
    /**
     * Taking the money, answered by Payments (slice 5.2c).
     *
     * **A port rather than a service**, so nothing about a card, a provider or an
     * idempotency key reaches the booking machine — BRD §5.1 gives Payments the
     * money and forbids provider-specific code here.
     */
    private readonly payments: HirePayments,
    /**
     * Who is owed the money, answered by Catalogue (slice 5.2c).
     *
     * **The ownership port, not the quotable one.** `bookings` keeps no owner
     * column on purpose, so a payee has to be asked for — and asking the port that
     * answers only about *bookable* listings would make a hire unpayable the
     * moment its owner paused the listing, which is a reasonable thing to do
     * after accepting.
     */
    private readonly ownership: ListingOwnership,
    /**
     * Whether paying is switched on at all (slice 5.2c).
     *
     * **Off by default, because there is no payment provider yet.** See
     * `payment-switch.ts` for why this is a flag rather than a missing route or a
     * provider that always fails.
     */
    private readonly paymentSwitch: PaymentSwitch,
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

    const created = await this.createOrExplainDuplicate(
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
        /*
         * **Off the quote, with the money, and not recomputed from the listing.**
         * The excess is the band applied to `listing.replacementValue`, and that
         * column is mutable — an owner may have edited it in the half hour since
         * the quote was given. Recomputing here would silently hold a figure the
         * renter was never shown, which is the exact failure §8.7.2 forbids by
         * requiring the values be *"shown to both parties before booking"*.
         */
        appliedExcess: quote.appliedExcess,
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
   * Create the booking, and turn a re-used quote into a sentence (slice 4.7a).
   *
   * **The constraint is the guarantee and this is the manners.** `bookings.quoteId`
   * is unique from 4.7a, so a double-press or a second tab is refused by Postgres
   * rather than producing two identical `REQUESTED` rows — §7.1 leaves `REQUESTED`
   * out of §8.5.1's occupying states on purpose, so the `EXCLUDE` constraint never
   * saw them. Untranslated that refusal is a 500 on a button the renter has already
   * successfully pressed, which is wrong about the outcome as well as the cause.
   *
   * **It deliberately does not return the first booking instead.** Reading it back
   * and answering 200 would be friendlier and would also mean two presses and one
   * press are indistinguishable to the caller — so a client with a genuine bug that
   * submits twice would never find out. §8.6 gives the renter one request; saying so
   * is the honest answer, and 4.8's dashboard is where they will see the one that
   * exists.
   */
  private async createOrExplainDuplicate(
    ...args: Parameters<BookingStore['createWithEvent']>
  ): ReturnType<BookingStore['createWithEvent']> {
    try {
      return await this.bookings.createWithEvent(...args);
    } catch (error) {
      if (error instanceof DuplicateQuoteBookingError) {
        throw new RequestRefusedError(
          'You have already requested this hire. We have only kept the first ' +
            'request — asking again would have made two.',
        );
      }
      throw error;
    }
  }

  /**
   * The requests waiting on an owner for one listing (§8.6, §7.1, slice 4.6).
   *
   * **Owner-scoped in the store's query**, so a listing that is not theirs comes
   * back empty rather than forbidden — the rule every owner-scoped read here
   * follows, and the one that stops a stranger learning a listing id is real.
   *
   * **Expired requests are not offered.** §8.6 gives a request a deadline, and a
   * page that let an owner accept past it would be the deadline not existing.
   * 4.7's worker will move them to `EXPIRED`; until then the read honours it.
   */
  async pendingRequests(listingId: string, ownerId: string): Promise<ListingRequests> {
    const pending = await this.bookings.findPendingRequests(
      listingId,
      ownerId,
      this.now(),
    );

    return { requests: pending.map(toListingRequest) };
  }

  /**
   * Accept a request (§8.6), locking the dates and declining every conflict (§7.1).
   *
   * **The refusals, in the order they run** — the same shape as `request` above:
   *
   * 1. **Is this booking this owner's?** Not theirs and no such booking are one
   *    answer, so nobody learns a booking id is real by guessing.
   * 2. **Is it still a request?** Expired, already declined, or accepted in
   *    another tab. Refused with a sentence rather than a 404 — the owner asked
   *    for something that was true a minute ago.
   * 3. **Are the dates still free?** The check the phase handoff names, because
   *    `EXCLUDE` cannot span two tables: an owner can block dates *after* a
   *    request arrives, and accepting would then contradict their own calendar.
   * 4. **Did another acceptance get there first?** That one is the database's and
   *    is deliberately not pre-empted — moving into `ACCEPTED` is what applies
   *    §8.5.1's constraint, and checking first is the anti-pattern it names. The
   *    read in step 3 is a courtesy, not the control.
   *
   * **The transition is asserted before the store is asked to write it**, exactly
   * as creation is: §7 opens by saying transitions are validated centrally and
   * *"UI buttons must never directly invent transitions"*, and an accept button is
   * the single most likely thing to invent one.
   *
   * **It rests in `ACCEPTED` rather than moving straight on, and that is a
   * decision.** §7.1 says to move it there; its two onward states are both wrong
   * today. `RESERVED` means *"rental payment secured"*, false until Phase 5.
   * `AWAITING_PAYMENT` means *"acceptance occurred but payment not complete"* —
   * true, but it implies a payment flow that does not exist, and it releases
   * nothing anyway because its `EXPIRED` edge is as unbuilt as the rest. **So an
   * accepted booking cannot be undone in the product**, and the owner is told that
   * where they decide rather than discovering it afterwards (product owner,
   * 18 August 2026).
   */
  async accept(bookingId: string, ownerId: string): Promise<Booking | null> {
    const existing = await this.bookings.findForParty(bookingId, ownerId);
    if (existing === null) return null;

    const { booking } = existing;
    if (booking.state !== 'REQUESTED') {
      throw new RequestRefusedError(
        'That request is no longer waiting for an answer. Reload the page to see ' +
          'what is.',
      );
    }

    if (booking.requestExpiresAt <= this.now()) {
      /*
       * §8.6's deadline, enforced here as well as in the store's query. Accepting
       * past it would bind a renter to a hire they were entitled to treat as
       * dead — and 4.7's worker does not exist yet to have moved it on.
       */
      throw new RequestRefusedError(
        'That request has expired, so it can no longer be accepted. The renter can ' +
          'ask again.',
      );
    }

    // The whole reason this is here rather than left to the constraint: an
    // `EXCLUDE` cannot see the availability table.
    const unavailable = await this.availability.reasonUnavailable(
      booking.listingId,
      booking.startAt,
      booking.endAt,
    );
    if (unavailable !== null) {
      throw new RequestRefusedError(describeUnavailableToOwner(unavailable));
    }

    assertTransition('REQUESTED', 'ACCEPTED');

    const result = await this.bookings.accept(bookingId, ownerId, this.now());
    /* c8 ignore next -- unreachable: it was this owner's a moment ago. */
    if (result === null) return null;

    return this.readBack(bookingId, ownerId);
  }

  /**
   * Decline a request (§8.6).
   *
   * **Deliberately shorter than accepting, and the asymmetry is the point.** A
   * decline locks nothing, frees nothing and races nothing, so there is no
   * availability to consult and no constraint to lose to. Saying no is cheap.
   *
   * **A decline past the deadline is allowed**, unlike an acceptance. The deadline
   * exists so a renter is not held indefinitely; declining after it costs them
   * nothing they had not already lost, and refusing would leave the owner staring
   * at a request they cannot clear.
   */
  async decline(bookingId: string, ownerId: string): Promise<Booking | null> {
    const existing = await this.bookings.findForParty(bookingId, ownerId);
    if (existing === null) return null;

    if (existing.booking.state !== 'REQUESTED') {
      throw new RequestRefusedError(
        'That request is no longer waiting for an answer. Reload the page to see ' +
          'what is.',
      );
    }

    assertTransition('REQUESTED', 'DECLINED');

    const declined = await this.bookings.decline(bookingId, ownerId, this.now());
    /* c8 ignore next -- unreachable: it was this owner's a moment ago. */
    if (declined === null) return null;

    return this.readBack(bookingId, ownerId);
  }

  /**
   * Pay for a booking the owner accepted (§7, §8.7, slice 5.2c).
   *
   * **This is the first thing in the project that moves money**, and the shape it
   * takes is decided by Strong Customer Authentication rather than by preference:
   * a UK card payment usually cannot finish in one request. §7 knew — `ACCEPTED →
   * AWAITING_PAYMENT → RESERVED | PAYMENT_FAILED` — and the middle state is where
   * a booking sits while the renter answers their bank.
   *
   * ## Three states may be paid from, and each for its own reason
   *
   * - **`ACCEPTED`** — the ordinary case. The owner said yes and nothing has been
   *   attempted.
   * - **`PAYMENT_FAILED`** — §7's `AWAITING_PAYMENT (retry)` edge. A declined card
   *   is not the end of a booking, and the attempt key Payments derives makes the
   *   retry a genuinely new attempt rather than a replay of the first failure.
   * - **`AWAITING_PAYMENT`** — a resume, and the case worth reading twice. A renter
   *   who closed the tab mid-challenge, or a process that died between the charge
   *   and the state change, leaves a booking here. Calling this again is what
   *   repairs it: Payments returns the attempt already open rather than charging
   *   again, and if that attempt has since succeeded the booking moves on. **The
   *   repair is a retry, which is why both sides had to be idempotent.**
   *
   * Anything else refuses with a sentence. A `RESERVED` booking is already paid;
   * a `DECLINED` or `EXPIRED` one never will be.
   *
   * ## The order, which is the same argument Payments makes one layer down
   *
   * **The booking moves to `AWAITING_PAYMENT` before the provider is called.** The
   * other order takes money against a booking still reading `ACCEPTED`, with
   * nothing on this side recording that an attempt was ever made. This way a crash
   * anywhere after that leaves a booking that says *payment in progress* — which
   * is true, and which the resume above then finishes.
   *
   * Resolves to null when the booking is not this renter's or does not exist.
   * **The owner gets null too**: §8.6 gives them the decision and the renter the
   * bill, and a 403 would confirm the id is real.
   *
   * Throws {@link RequestRefusedError} when the state cannot be paid from.
   */
  async pay(bookingId: string, renterId: string): Promise<BookingPayment | null> {
    /*
     * **First, and before the booking is even read.** There is no payment provider
     * until 5.2e, so this is the honest state of the platform rather than a
     * temporary guard — and refusing here means nothing is written, nothing moves
     * and no booking is stranded in `AWAITING_PAYMENT` waiting for something that
     * cannot happen. Turning the flag on is the whole of what 5.2e has to do.
     */
    if (!(await this.paymentSwitch.isPaymentEnabled())) {
      throw new RequestRefusedError(PAYMENT_NOT_ENABLED);
    }

    const existing = await this.bookings.findForParty(bookingId, renterId);
    if (existing === null) return null;

    const { booking } = existing;
    /*
     * **`findForParty` answers for either party, and only one of them pays.** The
     * owner reading their own booking here would otherwise be able to pay for it,
     * which is both wrong and a way for an owner to move their own booking to
     * `RESERVED`. Null rather than a refusal, so it is indistinguishable from a
     * booking that does not exist.
     */
    if (booking.renterId !== renterId) return null;

    if (!PAYABLE_STATES.includes(booking.state)) {
      throw new RequestRefusedError(describeUnpayable(booking.state));
    }

    /*
     * **Asked before the state moves**, so a listing that has somehow lost its
     * owner refuses rather than stranding a booking in `AWAITING_PAYMENT`. It
     * cannot happen — the foreign key is `RESTRICT` and accounts are soft-deleted
     * — which is exactly why the failure would be baffling if it did.
     */
    const ownerId = await this.ownership.ownerOf(booking.listingId);
    if (ownerId === null) {
      throw new RequestRefusedError(
        'That item is no longer available to pay for. Nothing has been charged.',
      );
    }

    const awaiting = await this.movePayable(booking.state, bookingId, renterId);
    if (awaiting === null) {
      /*
       * Somebody else moved it between the read and the write — the renter's own
       * second tab, most likely. Not an error and not a charge: they are told to
       * look again, exactly as a stale accept is.
       */
      throw new RequestRefusedError(
        'That booking changed while you were paying. Reload the page to see where ' +
          'it stands. Nothing has been charged twice.',
      );
    }

    const result = await this.payments.chargeForHire({
      bookingId,
      ownerId,
      categoryVersionId: booking.categoryVersionId,
      itemTitle: booking.itemTitle,
      itemCharge: booking.itemCharge,
      renterFee: booking.renterFee,
      total: booking.total,
    });

    await this.settle(bookingId, renterId, result.status);

    return {
      booking: await this.readBackForRenter(bookingId, renterId),
      payment: {
        status: result.status,
        ...(result.payerAction === undefined
          ? {}
          : { payerAction: result.payerAction }),
        ...(result.failureMessage === undefined
          ? {}
          : { failureMessage: result.failureMessage }),
      },
    };
  }

  /**
   * Get the booking to `AWAITING_PAYMENT`, from wherever it is.
   *
   * **Three sources, one destination**, and `AWAITING_PAYMENT → AWAITING_PAYMENT`
   * is not one of them: §7 has no such edge and asserting it would fail. A resume
   * is already there, so there is nothing to move and nothing to write down — a
   * `state-changed` event from a state to itself would be a history entry
   * recording that nothing happened.
   */
  private async movePayable(
    from: BookingState,
    bookingId: string,
    renterId: string,
  ): Promise<'moved' | null> {
    if (from === 'AWAITING_PAYMENT') return 'moved';

    assertTransition(from, 'AWAITING_PAYMENT');

    const moved = await this.bookings.advance({
      bookingId,
      from,
      to: 'AWAITING_PAYMENT',
      actorId: renterId,
      now: this.now(),
    });

    return moved === null ? null : 'moved';
  }

  /**
   * Move the booking to wherever the charge left it.
   *
   * **`processing` and `pending_payer_action` move nothing**, deliberately: the
   * booking is already in `AWAITING_PAYMENT` and that is exactly what those two
   * mean. §7 gives it no other home until an outcome arrives.
   *
   * **A losing race is silently fine here**, unlike above. `advance` returns null
   * when the booking has already left `AWAITING_PAYMENT` — which is what 5.2e's
   * webhook confirming the same payment a moment earlier looks like. The money is
   * recorded either way, because the *ledger* posting is Payments' and is keyed
   * per booking; this is the mirror catching up, and it must not turn a duplicate
   * into an error the renter sees.
   */
  private async settle(
    bookingId: string,
    renterId: string,
    status: HireChargeResult['status'],
  ): Promise<void> {
    if (status === 'processing' || status === 'pending_payer_action') return;

    const to: BookingState = status === 'succeeded' ? 'RESERVED' : 'PAYMENT_FAILED';
    assertTransition('AWAITING_PAYMENT', to);

    await this.bookings.advance({
      bookingId,
      from: 'AWAITING_PAYMENT',
      to,
      /*
       * **The renter, because the renter pressed pay.** From 5.2e a webhook will
       * write the same transition with `actorId: null`, which is the honest answer
       * when the platform acted on a provider's word rather than a person's click.
       */
      actorId: renterId,
      now: this.now(),
    });
  }

  /**
   * The booking as its history now stands, for the renter.
   *
   * `readBack` beside this takes an owner id; the scope check is the same one and
   * the parameter name is the only difference, so this exists to keep the call
   * sites honest about who is asking rather than to do anything else.
   */
  private async readBackForRenter(
    bookingId: string,
    renterId: string,
  ): Promise<Booking> {
    return this.readBack(bookingId, renterId);
  }

  /**
   * The booking as its history now stands.
   *
   * **A second read rather than assembling a projection from the write's return
   * value**, which is what `request` does and for the same reason: §6.2 makes the
   * event log part of what a booking *is*, and a projection built from the row
   * alone would show a state its history does not explain.
   */
  private async readBack(bookingId: string, ownerId: string): Promise<Booking> {
    const withEvents = await this.bookings.findForParty(bookingId, ownerId);
    /* c8 ignore next -- unreachable: we just wrote it and it is theirs. */
    if (withEvents === null)
      throw new Error('a booking vanished between write and read');

    return toWireBooking(withEvents);
  }

  /**
   * Every booking this person requested (§14's *dashboards for both parties*,
   * slice 4.8a).
   *
   * **The first place a renter can see a booking after making it.** Until this,
   * 4.5b's confirmation panel was the only place one was ever shown to them and a
   * reload lost it — so a request could expire, be accepted or be declined with
   * nothing anywhere telling them.
   *
   * **Bounded with the cut declared**, never silently. See
   * `DEFAULT_BOOKING_LIST_LIMIT` for why the bound is what it is.
   */
  async listForRenter(
    renterId: string,
    limit: number = DEFAULT_BOOKING_LIST_LIMIT,
  ): Promise<BookingSummaries> {
    const bounded = boundedBookingLimit(limit);
    const rows = await this.bookings.findForRenter(renterId, Paging.probe(bounded));
    const page = Paging.fitTo(rows, bounded);

    return { bookings: page.items.map(toBookingSummary), truncated: page.truncated };
  }

  /**
   * Every booking on this owner's listings (slice 4.8a).
   *
   * **Every state, and it is deliberately not a second `pendingRequests`.** That
   * one answers *what must I decide on this listing* and honours §8.6's deadline
   * by excluding anything past it; this answers *what is happening across
   * everything I own*. An owner whose dashboard hid the pending ones would go
   * hunting listing by listing for them, and one whose dashboard offered the
   * decision controls would put the same action in two places — so the rows link
   * to the listing and 4.6b keeps the buttons.
   */
  async listForOwner(
    ownerId: string,
    limit: number = DEFAULT_BOOKING_LIST_LIMIT,
  ): Promise<OwnerBookings> {
    const bounded = boundedBookingLimit(limit);
    const rows = await this.bookings.findForOwner(ownerId, Paging.probe(bounded));
    const page = Paging.fitTo(rows, bounded);

    return {
      bookings: page.items.map(toOwnerBookingSummary),
      truncated: page.truncated,
    };
  }

  /**
   * One booking, as either party reads it, with whether they may pay for it
   * (slice 5.2d).
   *
   * Null for "no such booking" and for "not yours", which the route answers 404
   * to — the rule every scoped read in this project follows.
   *
   * **The flag is read on this route and on no other read.** It is one store
   * lookup that cannot throw (`PaymentSwitch` answers with the declared default
   * on an outage, which for this flag is *off*), and it buys the renter's page
   * the ability to draw a control that works or a sentence that is true. The
   * collection routes deliberately do not carry payability: a list has no pay
   * button, and putting a flag read behind every row would be a cost paid for
   * nothing.
   *
   * **Suspension comes from the caller rather than being looked up**, because the
   * guard has already resolved it — `MirroredUser.suspendedAt` is on the request.
   * Asking identity again would be a second answer to a question already
   * answered, and the two could disagree within one request.
   */
  async find(
    id: string,
    userId: string,
    reader: BookingReader,
  ): Promise<BookingDetail | null> {
    const found = await this.bookings.findForParty(id, userId);
    if (found === null) return null;

    const booking = toWireBooking(found);
    const isRenter = found.booking.renterId === userId;

    return {
      ...booking,
      /*
       * **Both parties read this projection**, so the page has to know which one
       * it is addressing — see `bookingDetailSchema`. Decided here, beside the
       * payability that already depended on it, rather than inferred downstream
       * from a sentence.
       */
      viewer: isRenter ? 'renter' : 'owner',
      payability: payabilityOf({
        state: found.booking.state,
        isRenter,
        isSuspended: reader.isSuspended,
        paymentEnabled: await this.paymentSwitch.isPaymentEnabled(),
      }),
    };
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
/**
 * What an owner is told when their own calendar blocks an acceptance.
 *
 * **Different words from the renter's**, which is why this is not
 * `describeUnavailable`. A renter is told the item is unavailable; an owner is
 * told *they* made it so, and where to undo it. The same sentence for both would
 * be describing the wrong person's situation to one of them.
 */
function describeUnavailableToOwner(reason: UnavailableReason): string {
  return reason === 'blocked'
    ? 'You have blocked some of those dates since this request arrived. Remove the ' +
        'block on your calendar if you want to accept it.'
    : 'Those dates are already taken by a booking you have accepted.';
}

/**
 * One pending request, as its owner reads it (slice 4.6).
 *
 * **Dates, never instants** — 4.3b's rule, and the projection is `strictObject`
 * so an instant appearing here fails a test rather than reaching a page that
 * would render it in the browser's timezone. `requestExpiresAt` is the deliberate
 * exception, for the reason the quote's expiry is: it is a moment we chose, not a
 * day somebody typed.
 *
 * **The renter is not named and no payout is stated.** See `listingRequestSchema`,
 * where both omissions are argued.
 */
function toListingRequest({ booking, conflictCount }: PendingRequest): ListingRequest {
  return {
    id: booking.id,
    startDate: Time.toLocalDateString(booking.startAt),
    // Inclusive on the wire and exclusive in the column, exactly as
    // `toWireBooking` has it: "the 20th to the 22nd" ends at the start of the 23rd.
    endDate: inclusiveEndDate(booking.endAt),
    days: rentalPeriodDays(booking.startAt, booking.endAt, booking.timeZone),
    itemCharge: booking.itemCharge,
    /*
     * **The owner's half of §8.7.2's *"shown to both parties before booking"*.**
     * Their commitment is the acceptance, so the figure belongs on the thing they
     * accept — and unlike everything else here it is about the renter's exposure
     * rather than the owner's earnings. Somebody handing over a £900 breaker is
     * entitled to know what stands behind it.
     */
    appliedExcess: booking.appliedExcess,
    requestExpiresAt: Time.toIsoUtc(booking.requestExpiresAt),
    conflictCount,
  };
}

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
    endDate: inclusiveEndDate(booking.endAt),
    days: rentalPeriodDays(booking.startAt, booking.endAt, booking.timeZone),
    itemTitle: booking.itemTitle,
    categoryName: booking.categoryName,
    itemCharge: booking.itemCharge,
    renterFee: booking.renterFee,
    total: booking.total,
    /*
     * **The figure this booking was made under**, read off the row rather than
     * recomputed from the listing (§8.7.2, §8.2). It renders correctly after the
     * item has been repriced, revalued, paused or erased — which is the whole
     * point of a booking copying its terms.
     */
    appliedExcess: booking.appliedExcess,
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

/**
 * How many bookings a dashboard reads at once.
 *
 * **The same 50 that the activity list and the sign-in list use**, and shared with
 * neither on purpose: those bounds answer questions about their own collections,
 * and a constant three modules import is one that cannot be changed for one of
 * them. The number is a page a person can scroll, not a guess about scale.
 */
export const DEFAULT_BOOKING_LIST_LIMIT = 50;

/**
 * An engineering bound on one query's cost, mirroring `MAX_ACTIVITY_LIMIT`.
 *
 * **No route exposes a limit today**, so nothing can reach this yet — it is here
 * because the service takes a number and a service that takes an unclamped number
 * is one a later controller can hand a query parameter to. `Paging.boundedLimit`
 * turns `NaN` into the fallback rather than the maximum, which is the whole point
 * of routing it through there rather than a `Math.min`.
 */
export const MAX_BOOKING_LIST_LIMIT = 200;

function boundedBookingLimit(limit: number): number {
  return Paging.boundedLimit(limit, {
    fallback: DEFAULT_BOOKING_LIST_LIMIT,
    max: MAX_BOOKING_LIST_LIMIT,
  });
}

/**
 * The inclusive last day, from the exclusive bound the column holds.
 *
 * Extracted in 4.8a because four projections now perform it — `toWireBooking`,
 * `toListingRequest` and both summaries. "The 20th to the 22nd" ends at the start
 * of the 23rd, and the conversion back is the one piece of arithmetic every
 * booking projection shares.
 */
function inclusiveEndDate(endAt: Date): string {
  return Time.addLocalDays(Time.toLocalDateString(endAt), -1);
}

/**
 * One booking in the renter's list (slice 4.8a).
 *
 * **The inclusive total and no breakdown** — §3.4.4 requires the figure to include
 * mandatory fees wherever a price appears, and the split into charge and fee
 * belongs beside the detail that explains it, on `GET /bookings/:bookingId`.
 *
 * **No events.** §6.2's history is what a record of one hire is; fetching an
 * unbounded array per row to draw a line of text is the thing a summary exists to
 * avoid.
 */
function toBookingSummary(booking: BookingRecord): BookingSummary {
  return {
    id: booking.id,
    listingId: booking.listingId,
    state: booking.state,
    startDate: Time.toLocalDateString(booking.startAt),
    endDate: inclusiveEndDate(booking.endAt),
    days: rentalPeriodDays(booking.startAt, booking.endAt, booking.timeZone),
    itemTitle: booking.itemTitle,
    categoryName: booking.categoryName,
    total: booking.total,
    requestExpiresAt: Time.toIsoUtc(booking.requestExpiresAt),
  };
}

/**
 * One booking in the owner's list (slice 4.8a).
 *
 * **`itemCharge` and no payout, and the renter is not named** — both are
 * `listingRequestSchema`'s decisions, reused here rather than re-argued. The
 * commission arithmetic is Phase 5, so any figure presented as *what I receive*
 * would be false today; and identity arriving with commitment is a decision with
 * no mechanism behind it, which makes a name additive later and unremovable now.
 */
function toOwnerBookingSummary(booking: BookingRecord): OwnerBookingSummary {
  return {
    id: booking.id,
    listingId: booking.listingId,
    state: booking.state,
    startDate: Time.toLocalDateString(booking.startAt),
    endDate: inclusiveEndDate(booking.endAt),
    days: rentalPeriodDays(booking.startAt, booking.endAt, booking.timeZone),
    itemTitle: booking.itemTitle,
    itemCharge: booking.itemCharge,
    requestExpiresAt: Time.toIsoUtc(booking.requestExpiresAt),
  };
}

export { OverlappingBookingError };
