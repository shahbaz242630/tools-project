import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  ContractViolationError,
  LISTING_AVAILABILITY_BLOCK_ROUTE,
  LISTING_AVAILABILITY_ROUTE,
  calendarMonthSchema,
  parseAvailabilityBlockRequest,
} from '@platform/contracts';
import type { AvailabilityBlock, ListingAvailability } from '@platform/contracts';
import { AllowsSuspended, AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { AVAILABILITY_SERVICE } from './booking.tokens.js';
import { BlockRefusedError } from './availability.service.js';
import type { AvailabilityService } from './availability.service.js';

/**
 * An owner's calendar, as they manage it (BRD §8.5, slice 4.3b).
 *
 * **Authenticated, not administrative** — `owner-listings.controller.ts`'s
 * shape, for its reason: anybody may rent out a lawnmower, so what replaces a
 * role check is ownership, and ownership is enforced inside the query rather
 * than by comparing ids afterwards.
 *
 * **404 for somebody else's listing, never 403**, on all three routes. A 403
 * confirms the listing exists, which is the whole thing the check protects.
 *
 * **There is no public route here and there must never be one.** A renter
 * learns that a period is unavailable from the booking path, which answers
 * *whether* — never *why*, and never from this projection: `reason` is the
 * owner's own note and "away until the 14th" is a sentence about somebody's
 * house being empty.
 */
@Controller()
@UseGuards(AuthGuard)
export class OwnerAvailabilityController {
  constructor(
    @Inject(AVAILABILITY_SERVICE) private readonly availability: AvailabilityService,
  ) {}

  /**
   * A month of the calendar.
   *
   * **`@AllowsSuspended()`.** Reading what we hold about you survives suspension
   * (ADR 0024), and a calendar is a record of what its owner told us.
   *
   * **The month defaults rather than being required**, because the first
   * request a page makes is *"show me now"* and a required parameter would put
   * today's date arithmetic in the caller — which is the browser, in a timezone
   * that is not ours. **The default itself is the service's**, which is the one
   * thing here holding a clock; this route only checks the shape of a month
   * somebody did supply.
   */
  @Get(LISTING_AVAILABILITY_ROUTE)
  @AllowsSuspended()
  async month(
    @Param('id') id: string,
    @Query('month') month: string | undefined,
    @CurrentUser() owner: MirroredUser,
  ): Promise<ListingAvailability> {
    const calendar = await this.availability.readMonth(
      id,
      owner.id,
      month === undefined ? undefined : parseMonth(month),
    );
    if (calendar === null) throw new NotFoundException();

    return calendar;
  }

  /**
   * Declare a period unavailable.
   *
   * **`@AllowsSuspended()`, and it is the pause rule rather than an exception to
   * it.** ADR 0024 stops a suspended account writing anything others would see;
   * blocking dates makes an item *less* available, which is the same direction
   * as pausing a listing — the one write `owner-listings.controller.ts` also
   * leaves open. Refusing it would force a suspended owner to keep offering
   * dates they cannot honour.
   */
  @Post(LISTING_AVAILABILITY_ROUTE)
  @AllowsSuspended()
  async block(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() owner: MirroredUser,
  ): Promise<AvailabilityBlock> {
    const request = parse(() => parseAvailabilityBlockRequest(body));

    try {
      const created = await this.availability.block(id, owner.id, request);
      if (created === null) throw new NotFoundException();

      return created;
    } catch (error) {
      if (error instanceof BlockRefusedError) {
        /*
         * **422, not 400.** The body is well formed and every field is the type
         * it should be — what is wrong is the period itself, which no
         * correction to the *shape* of the request would fix. It is the same
         * line `owner-listings.controller.ts` draws between a field error and a
         * listing that is not ready.
         *
         * No `issues` array. That shape means "these fields were rejected" and
         * a client rendering it would put a sentence about the year under the
         * start date when the objection is to the pair.
         */
        throw new UnprocessableEntityException({ message: error.refusal });
      }
      throw error;
    }
  }

  /**
   * Remove a declared period.
   *
   * **Not `@AllowsSuspended()`, and this is the asymmetry the pause and publish
   * pair already established.** Unblocking puts dates back on offer, which is a
   * write strangers would see — the thing ADR 0024 suspends. Blocking, above,
   * takes them away and stays open.
   *
   * **204, with no body.** There is nothing left to return, and answering with
   * the deleted period would invite a page to render what it just removed.
   */
  @Delete(LISTING_AVAILABILITY_BLOCK_ROUTE)
  @HttpCode(204)
  async unblock(
    @Param('id') id: string,
    @Param('blockId') blockId: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<void> {
    const removed = await this.availability.unblock(id, owner.id, blockId);
    // False covers "not your listing" and "no such block", and both are 404 —
    // see the service. Reporting success for a row that was never there would
    // let a page redraw as though something had happened.
    if (!removed) throw new NotFoundException();
  }
}

/**
 * A month from the query string, or a 400 naming what was expected.
 *
 * Parsed rather than trusted: it goes straight into date arithmetic, and an
 * unparseable value would otherwise surface as a `TimeError` — a 500 on a route
 * anybody reaches by editing a URL.
 */
function parseMonth(month: string): string {
  const result = calendarMonthSchema.safeParse(month);
  if (!result.success) {
    throw new BadRequestException({
      message: 'That is not a month we can show.',
      issues: ['month: must be a month, as YYYY-MM'],
    });
  }

  return result.data;
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
