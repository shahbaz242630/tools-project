import {
  BadRequestException,
  Body,
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
  ContractViolationError,
  LISTING_QUOTES_ROUTE,
  QUOTE_ROUTE,
  parseQuoteRequest,
} from '@platform/contracts';
import type { RentalQuote } from '@platform/contracts';
import { AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { QUOTES_SERVICE } from './booking.tokens.js';
import { QuoteRefusedError } from './quotes.service.js';
import type { QuotesService } from './quotes.service.js';

/**
 * A renter asking what a period costs (BRD §8.5.2, slice 4.4b).
 *
 * **Authenticated, and that is a decision rather than a default.** §6.2's `Quote`
 * entity names the renter's *postcode* and no renter, which taken literally would
 * let an anonymous visitor leave a postcode and a date range in the database with
 * no subject who could ask for it back — personal data with no erasure route,
 * which §10.1 does not allow. A stranger still sees the indicative `from £x/day`
 * on the listing page, which §8.5.2 explicitly permits before a postcode is
 * supplied.
 *
 * **Not `@AllowsSuspended()`, on either route.** A quote is the first step of
 * making a booking, and a suspended account may not transact (ADR 0024). This is
 * the ordinary application of that rule rather than an exception to it — unlike
 * the calendar, where blocking dates makes an item *less* available and stays
 * open.
 *
 * **No route lists a renter's quotes, deliberately.** Nothing needs one: a page
 * has the id it just created, and 4.5's request submission is given one. A
 * collection route would be a second, broader read of a table holding postcodes,
 * built for no caller.
 */
@Controller()
@UseGuards(AuthGuard)
export class QuotesController {
  constructor(@Inject(QUOTES_SERVICE) private readonly quotes: QuotesService) {}

  /**
   * Price a period.
   *
   * **POST, and it writes** — a quote is a record we make, not a calculation we
   * hand back. That is what §8.5.2 requires: *"persists as a `Quote` record"*, so
   * the price can be reproduced and audited.
   *
   * **404 for a listing this person cannot book**, covering four facts at once —
   * no such listing, not published, hidden by the platform, or an owner who has
   * not declared themselves a private individual. A renter must not be able to
   * tell them apart, and the service returns one null for all four.
   *
   * **422 for a period we will not price**, with a sentence and no `issues`
   * array. The body is well formed and every field is the type it should be; what
   * is wrong is the period, the price or the listing being the caller's own — none
   * of which a correction to the *shape* of the request would fix. It is the same
   * line `owner-availability.controller.ts` draws.
   */
  @Post(LISTING_QUOTES_ROUTE)
  async create(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @CurrentUser() renter: MirroredUser,
  ): Promise<RentalQuote> {
    const request = parse(() => parseQuoteRequest(body));

    try {
      const quote = await this.quotes.quote(listingId, renter.id, request);
      if (quote === null) throw new NotFoundException();

      return quote;
    } catch (error) {
      if (error instanceof QuoteRefusedError) {
        throw new UnprocessableEntityException({ message: error.refusal });
      }
      throw error;
    }
  }

  /**
   * Read a quote back.
   *
   * **This was written so a price could survive a page reload, and no price
   * does — nothing calls this route.** Found by the pre-Phase-5 audit on
   * 19 August 2026: `quotePath` appears only in tests, and `request-panel.tsx`
   * holds its quote in form-action state, so a reload drops it and the renter
   * re-quotes. The sentence here claimed the opposite until now, which is the
   * defect class this project keeps finding — a purpose written down at the
   * moment of building and never checked against a caller.
   *
   * **Re-quoting is not harmful**, which is why this is a note rather than a
   * bug: dates are still on the page, quoting is a `POST` a renter can repeat,
   * and a fresh quote is priced from the same versioned configuration. What is
   * lost is only the expiry clock, and starting that again is the honest answer
   * to a reload anyway.
   *
   * **So it is unused surface with a deadline**, exactly as `GET
   * /bookings/:bookingId` is: if Phase 5 closes without a caller, delete it.
   *
   * **An expired quote is 200, not 404 or 410.** It exists, it is theirs, and
   * `expiresAt` says it has passed — a renter who left the page open is owed
   * *"this price has expired"* rather than *"no such thing"*. Deciding what may be
   * *done* with an expired quote is 4.5's, where a booking is made.
   */
  @Get(QUOTE_ROUTE)
  async find(
    @Param('quoteId') quoteId: string,
    @CurrentUser() renter: MirroredUser,
  ): Promise<RentalQuote> {
    const quote = await this.quotes.find(quoteId, renter.id);
    // Null covers "no such quote" and "not yours" — see the store. Answering
    // differently would confirm that a quote id exists.
    if (quote === null) throw new NotFoundException();

    return quote;
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
