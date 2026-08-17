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
  BOOKING_ROUTE,
  ContractViolationError,
  parseBookingRequest,
} from '@platform/contracts';
import type { Booking } from '@platform/contracts';
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
 * **There is no route here that lists a person's bookings.** 4.8's dashboards are
 * what need one, and building it now would be a broad read of a table holding two
 * people's terms with no caller. Both routes here answer about one booking.
 */
@Controller()
@UseGuards(AuthGuard)
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
   */
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
