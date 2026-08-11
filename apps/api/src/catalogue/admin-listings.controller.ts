import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_LISTING_MODERATION_ROUTE,
  ContractViolationError,
  parseModerationDecision,
} from '@platform/contracts';
import type { ModerationState } from '@platform/contracts';
import { AuthGuard, Roles } from '../identity/auth.guard.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import type { Actor } from '../audit/audit-log.js';
import { LISTINGS_SERVICE } from './catalogue.tokens.js';
import { ModerationReasonRequiredError } from './listings.service.js';
import type { ListingsService } from './listings.service.js';

/**
 * Listings, as an administrator moderates them (§8.3, §9, ADR 0041).
 *
 * **A separate controller from `OwnerListingsController`, and the separation is
 * a security boundary rather than a filing decision.** That one is authenticated
 * but not administrative: any signed-in account reaches it, and what protects a
 * listing there is *ownership enforced in the query*. Here there is no ownership
 * to enforce — a moderator's whole job is to act on listings that are not
 * theirs — so **the role and its second factor are the only thing standing in
 * front of every listing on the platform.**
 *
 * Keeping the two apart means the next route added to either inherits the right
 * story from its neighbours. A moderation route sitting among owner routes is
 * one somebody later copies without the `@Roles`.
 *
 * `@Roles('ADMIN')` also requires a second factor verified in the last twelve
 * hours (ADR 0021), and an absent claim fails closed. In local development
 * ADR 0030's flag removes the factor and never the role.
 *
 * **There is no moderation queue here, and that is scope rather than omission.**
 * §14 puts manual moderation queues in Phase 9 and automated content signals in
 * Phase 6. What Phase 2 owes is the state and the decision that sets it.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminListingsController {
  constructor(@Inject(LISTINGS_SERVICE) private readonly listings: ListingsService) {}

  /**
   * Decide what the platform permits of this listing.
   *
   * `PUT`, because the decision replaces whatever the last one was and
   * re-sending it is the same decision.
   *
   * **404 for a listing that does not exist, and that is deliberately the same
   * answer an owner gets.** A moderator learning which ids are real is harmless
   * in itself; a route that behaves differently for a real id is a probe, and
   * the uniformity costs nothing here.
   */
  @Put(ADMIN_LISTING_MODERATION_ROUTE)
  @Roles('ADMIN')
  async moderate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ readonly moderationState: ModerationState }> {
    const decision = parse(() => parseModerationDecision(body));

    try {
      const moderated = await this.listings.moderate({
        listingId: id,
        state: decision.state,
        reason: decision.reason ?? null,
        actor: actorOf(admin, request),
      });
      if (moderated === null) throw new NotFoundException();

      /*
       * **The decision, and nothing else.** Not the listing.
       *
       * A moderator needs to know their decision landed; they do not need the
       * owner's collection address, and this is the one route on which somebody
       * who is not the owner could receive it. `OwnerListing` carries the
       * outward code and town — coarse, and deliberately so — but it also
       * carries the full `collectionLocation` for the owner's own eyes, and
       * echoing the record back here would hand a moderator a stranger's
       * address as a side effect of pressing a button.
       *
       * §8.4.1's rule is that the precise address is disclosed only after a
       * booking reaches a state that permits it. A moderation decision is not
       * that state.
       */
      return { moderationState: moderated.moderationState };
    } catch (error) {
      if (error instanceof ModerationReasonRequiredError) {
        // 400, not 422: the body is genuinely missing a field and supplying it
        // is exactly what fixes the request. 422 is reserved for "the request
        // is fine and the listing's state is not" (slice 2.8a).
        throw new BadRequestException({
          message: error.message,
          issues: ['reason: A reason is required'],
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

/**
 * The actor, assembled from the guard's work rather than from the body.
 *
 * `admin-categories.controller.ts` has the same three lines and the duplication
 * is deliberate there too: a shared helper would be one import away from a
 * controller that has no `AuthenticatedRequest`, and the compiler would not say
 * so.
 */
function actorOf(admin: MirroredUser, request: AuthenticatedRequest): Actor {
  return {
    userId: admin.id,
    ipAddress: request.clientIp ?? null,
    sessionId: request.sessionId ?? null,
  };
}
