import { RateLimit, RateLimitGuard } from '../rate-limiting/rate-limit.guard.js';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  BOOKINGS_ROUTE,
  BOOKING_ACCEPT_ROUTE,
  BOOKING_DECLINE_ROUTE,
  BOOKING_PAY_ROUTE,
  BOOKING_ROUTE,
  ContractViolationError,
  LISTING_REQUESTS_ROUTE,
  OWNER_BOOKINGS_ROUTE,
  parseBookingRequest,
} from '@platform/contracts';
import type {
  Booking,
  BookingPayment,
  BookingSummaries,
  ListingRequests,
  OwnerBookings,
} from '@platform/contracts';
import { AllowsSuspended, AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { BOOKINGS_SERVICE } from './booking.tokens.js';
import { OverlappingBookingError } from './booking-store.js';
import { RequestRefusedError } from './bookings.service.js';
import type { BookingsService } from './bookings.service.js';

/**
 * Requesting a booking, and reading one back (BRD §8.6, slice 4.5a).
 *
 * **Not nested under the listing, unlike the quote routes.** A request names a
 * quote, and a quote already names its listing — a nested path would take a
 * listing id it would then have to check against the stored one, which is a second
 * scope to keep consistent where the renter scope is the one that protects
 * anything.
 *
 * **4.8a added the two that list them**, one per party. They are two routes
 * rather than one with a `?role=` because a role parameter is a scope the caller
 * chooses, and every scoped read in this system takes its scope from the session
 * and puts it in the query — see `bookings.ts` in the contracts, where the
 * decision is argued in full.
 */
@Controller()
@UseGuards(AuthGuard, RateLimitGuard)
export class BookingsController {
  constructor(@Inject(BOOKINGS_SERVICE) private readonly bookings: BookingsService) {}

  /**
   * Submit a request.
   *
   * **Four different failures, four different codes**, because a client can act
   * on the difference:
   *
   * - **404** — the quote is not this renter's, or does not exist. One answer for
   *   both, so a stranger cannot learn that a quote id is real.
   * - **422** — the request cannot be made and the renter can do something about
   *   it: the price expired, the listing was withdrawn, the dates went. A sentence,
   *   no `issues` array, because no correction to a *field* would fix it.
   * - **409** — somebody else booked the dates first. Its own code rather than
   *   another 422 because it is not the renter's fault and nothing they change
   *   fixes it; §7.1 auto-declines a loser rather than arguing with them, and
   *   4.6's acceptance is where that happens.
   * - **400** — the body is not a request at all.
   */
  @RateLimit('write')
  @Post(BOOKINGS_ROUTE)
  async request(
    @Body() body: unknown,
    @CurrentUser() renter: MirroredUser,
  ): Promise<Booking> {
    const request = parse(() => parseBookingRequest(body));

    try {
      const booking = await this.bookings.request(renter.id, request);
      if (booking === null) throw new NotFoundException();

      return booking;
    } catch (error) {
      if (error instanceof RequestRefusedError) {
        throw new UnprocessableEntityException({ message: error.refusal });
      }
      if (error instanceof OverlappingBookingError) {
        /*
         * **Translated here rather than in the service**, deliberately. The
         * service lets it through because 4.6 has to tell a lost race from a
         * refusal in order to auto-decline per §7.1 — that is a domain decision.
         * What a *renter* is owed is a sentence, and this is the only place that
         * knows it is talking to one.
         */
        throw new ConflictException({
          message:
            'Somebody else booked those dates while you were deciding. The calendar ' +
            'on the listing shows what is still free.',
        });
      }
      throw error;
    }
  }

  /**
   * The bookings this person requested (slice 4.8a).
   *
   * **The bare collection means *mine*, as `GET /listings` already does here.**
   * The scope is the session's and is applied in the store's query; there is no
   * parameter a caller could supply to widen it.
   *
   * **`@AllowsSuspended()`, for `find`'s reason.** ADR 0024 suspends the ability
   * to transact, not the ability to see what you are already party to — and a
   * suspended renter with a hire next week needs to be able to look at it more
   * than most people do.
   *
   * **No 404 and no 403.** A collection scoped to the session always exists;
   * somebody with no bookings reads an empty list, which is the truth.
   */
  @RateLimit('read')
  @Get(BOOKINGS_ROUTE)
  @AllowsSuspended()
  mine(@CurrentUser() renter: MirroredUser): Promise<BookingSummaries> {
    return this.bookings.listForRenter(renter.id);
  }

  /**
   * The bookings on this owner's listings (slice 4.8a).
   *
   * **`/owner/` names the audience**, as `/public/`, `/admin/` and `/internal/`
   * do — ADR 0048's argument for a prefix a log line and an eventual edge rule can
   * both read at a glance. It is also the reason this is not `/bookings/received`,
   * which would depend on the router preferring a static segment to `:bookingId`.
   *
   * **Owner-scoped through the listing, in the query.** An owner with no listings
   * reads an empty list, exactly as a stranger would.
   */
  @RateLimit('read')
  @Get(OWNER_BOOKINGS_ROUTE)
  @AllowsSuspended()
  owned(@CurrentUser() owner: MirroredUser): Promise<OwnerBookings> {
    return this.bookings.listForOwner(owner.id);
  }

  /**
   * Read a booking back.
   *
   * **`@AllowsSuspended()`, and it is ADR 0024's rule rather than an exception.**
   * Reading what we hold about you survives suspension — a booking is a record of
   * something a suspended person is still party to, and hiding it would take away
   * the history rather than the ability to transact. The request route above is
   * *not* marked, because making a booking is transacting.
   *
   * **Either party, 404 to anybody else.** §8.6 gives the owner the decision and
   * the renter the record; both read the same booking.
   *
   * **Nothing in the product calls this**, found by the pre-Phase-5 audit on
   * 19 August 2026: `bookingPath` appears only in tests, and there is no
   * `/bookings/[id]` page — both dashboards read the collection routes instead.
   * It is kept rather than deleted because Phase 5 has to put payment state
   * somewhere and this is the read half of a resource whose write half is
   * already in use, not a feature built for a user who does not exist.
   *
   * **That reasoning has a deadline, deliberately.** If Phase 5 closes without a
   * caller, delete it — an endpoint kept for a future that did not arrive is the
   * thing this project's own principle refuses, and "we might need it" is how
   * surface accumulates. Same for `GET /quotes/:quoteId`.
   */
  @RateLimit('read')
  @Get(BOOKING_ROUTE)
  @AllowsSuspended()
  async find(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: MirroredUser,
  ): Promise<Booking> {
    const booking = await this.bookings.find(bookingId, user.id);
    if (booking === null) throw new NotFoundException();

    return booking;
  }

  /**
   * The requests waiting on an owner for one listing (§8.6, §7.1, slice 4.6).
   *
   * **Nested under the listing, unlike the three routes above.** Those answer
   * about one booking whose id the caller already held; this asks *what is
   * waiting on me for this item*, which is a question about the listing.
   *
   * **`@AllowsSuspended()`: reading what is waiting on you is not transacting.**
   * ADR 0024 suspends the ability to act, not the ability to see — and an owner
   * who cannot read their requests cannot understand why their calendar is
   * filling up. Accepting and declining below are *not* marked.
   *
   * **An empty list for a listing that is not theirs**, never a 403. The store
   * scopes by owner in the query, so a stranger learns nothing about whether the
   * id is real.
   */
  @RateLimit('read')
  @Get(LISTING_REQUESTS_ROUTE)
  @AllowsSuspended()
  requests(
    @Param('id') listingId: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<ListingRequests> {
    return this.bookings.pendingRequests(listingId, owner.id);
  }

  /**
   * Accept a request (§8.6), which locks the dates and declines the rest (§7.1).
   *
   * **Four failures, four codes**, the same vocabulary the request route uses:
   *
   * - **404** — not this owner's booking, or no such booking. One answer for both.
   * - **422** — it cannot be accepted and the owner can act on why: it is no longer
   *   a request, it expired, or their own calendar now blocks the dates.
   * - **409** — somebody else's acceptance already holds the period. Its own code
   *   because nothing the owner changes fixes it, exactly as on the request route.
   * - **400** — never, from here: there is no body to be wrong.
   *
   * **Not `@AllowsSuspended()`.** Accepting binds a suspended account to a hire,
   * which is precisely the transacting ADR 0024 suspends.
   */
  @RateLimit('write')
  @Post(BOOKING_ACCEPT_ROUTE)
  async accept(
    @Param('bookingId') bookingId: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<Booking> {
    return this.decide(() => this.bookings.accept(bookingId, owner.id));
  }

  /**
   * Decline a request (§8.6).
   *
   * **The same codes as accepting, minus the 409** — a decline locks nothing, so
   * there is no race to lose. It is still routed through the same translation,
   * because a shared helper that handles a case one caller cannot reach is
   * cheaper than two helpers that drift.
   */
  @RateLimit('write')
  @Post(BOOKING_DECLINE_ROUTE)
  async decline(
    @Param('bookingId') bookingId: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<Booking> {
    return this.decide(() => this.bookings.decline(bookingId, owner.id));
  }

  /**
   * Pay for a booking the owner accepted (§8.7, slice 5.2c).
   *
   * **The renter's route, and the owner gets 404 from it.** §8.6 gives the owner
   * the decision and the renter the bill; answering 403 to an owner would confirm
   * the booking id is real to somebody who is not paying it. The service returns
   * null for both "not yours" and "no such booking", which is what makes them
   * indistinguishable here.
   *
   * **No body**, deliberately. What is owed was fixed when the booking was made
   * (§8.2) and is on its row — §8.7 requires charges to be calculated server-side
   * only, and a client that could send an amount could send the wrong one.
   *
   * **Not `@AllowsSuspended()`.** Paying binds a suspended account to a
   * completed transaction, which is exactly the transacting ADR 0024 suspends.
   * The read routes above are marked and these are not, which is the same line
   * accepting and declining already draw.
   *
   * **Three failures, three codes**, the vocabulary this controller already uses:
   *
   * - **404** — not this renter's booking, or no such booking.
   * - **422** — it cannot be paid for and the renter can read why: the state is
   *   wrong, it is already paid, or **payment is not switched on yet**. That last
   *   one is the ordinary answer today, because there is no payment provider
   *   until slice 5.2e — and it arrives *before* anything is written, so a
   *   booking is never left stranded mid-payment.
   * - **409** — never, from here. Nothing here races for an exclusive resource;
   *   a booking that moved under the renter is a 422 with a sentence, because
   *   reloading is what fixes it.
   */
  @RateLimit('write')
  @Post(BOOKING_PAY_ROUTE)
  async pay(
    @Param('bookingId') bookingId: string,
    @CurrentUser() renter: MirroredUser,
  ): Promise<BookingPayment> {
    try {
      const paid = await this.bookings.pay(bookingId, renter.id);
      if (paid === null) throw new NotFoundException();

      return paid;
    } catch (error) {
      if (error instanceof RequestRefusedError) {
        throw new UnprocessableEntityException({ message: error.refusal });
      }
      throw error;
    }
  }

  /**
   * One translation for both decisions.
   *
   * Accepting and declining fail in the same vocabulary and differ only in which
   * failures they can reach, so the mapping lives once. Two copies is how a
   * status added on one route stops being handled on the other — the H3a lesson
   * this codebase has now been taught twice.
   */
  private async decide(decision: () => Promise<Booking | null>): Promise<Booking> {
    try {
      const booking = await decision();
      if (booking === null) throw new NotFoundException();

      return booking;
    } catch (error) {
      if (error instanceof RequestRefusedError) {
        throw new UnprocessableEntityException({ message: error.refusal });
      }
      if (error instanceof OverlappingBookingError) {
        throw new ConflictException({
          message:
            'Those dates have just been taken by another booking, so this request ' +
            'can no longer be accepted.',
        });
      }
      throw error;
    }
  }
}

/** One place for the contract-violation translation, so no route can 500 on one. */
function parse<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ContractViolationError) {
      throw new BadRequestException({ message: error.message, issues: error.issues });
    }
    throw error;
  }
}
