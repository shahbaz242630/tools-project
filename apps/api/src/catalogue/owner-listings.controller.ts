import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CATEGORY_OPTIONS_ROUTE,
  ContractViolationError,
  LISTINGS_ROUTE,
  LISTING_ROUTE,
  parseListingDraft,
} from '@platform/contracts';
import type { CategoryOption, OwnerListing } from '@platform/contracts';
import { Time } from '@platform/core';
import { AllowsSuspended, AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { LISTINGS_SERVICE } from './catalogue.tokens.js';
import { UnknownCategoryError } from './listing-store.js';
import type { ListingRecord } from './listing-store.js';
import type { ListingsService } from './listings.service.js';

/**
 * Listings, as their owner manages them.
 *
 * **The first controller in this application that is authenticated but not
 * administrative.** No `@Roles`, so any signed-in account reaches it — which is
 * correct, because anybody may rent out a lawnmower. What replaces the role
 * check is ownership, and ownership is enforced in the *query* rather than by
 * comparing ids after the fact (see `ListingStore`).
 *
 * Suspension follows the rule `me-profile.controller.ts` established (ADR 0024):
 * a suspended person may **read** what we hold about them and may not **write**
 * anything others would see. So the read opts in and the create deliberately
 * does not.
 */
@Controller()
@UseGuards(AuthGuard)
export class OwnerListingsController {
  constructor(@Inject(LISTINGS_SERVICE) private readonly listings: ListingsService) {}

  /**
   * The categories an owner may list in.
   *
   * On this controller rather than the admin one because it answers a different
   * question for a different person: `/admin/categories` is configuration, and
   * this is a form control. It exists at all because a create form with nothing
   * to choose from is a dead control, which this project does not ship.
   *
   * Readable while suspended: it discloses nothing about anybody, and refusing
   * it would make the listing page fail in a way that looks like a fault.
   */
  @Get(CATEGORY_OPTIONS_ROUTE)
  @AllowsSuspended()
  async categories(): Promise<{ readonly categories: readonly CategoryOption[] }> {
    return { categories: await this.listings.categoryOptions() };
  }

  @Post(LISTINGS_ROUTE)
  async create(
    @Body() body: unknown,
    @CurrentUser() owner: MirroredUser,
  ): Promise<OwnerListing> {
    const draft = parse(() => parseListingDraft(body));

    try {
      const created = await this.listings.createDraft({
        ownerId: owner.id,
        categorySlug: draft.categorySlug,
        title: draft.title,
        description: draft.description,
        replacementValue: draft.replacementValue,
      });
      return toOwnerListing(created);
    } catch (error) {
      if (error instanceof UnknownCategoryError) {
        // 404 rather than 400: the body is well formed and the category was
        // real when the form was rendered. The fix is to choose again, not to
        // correct a field.
        throw new NotFoundException({ message: error.message });
      }
      throw error;
    }
  }

  /**
   * One of your own listings.
   *
   * 404 for somebody else's, never 403. A 403 would confirm the listing exists,
   * which is the whole thing the ownership check is protecting.
   */
  @Get(LISTING_ROUTE)
  @AllowsSuspended()
  async read(
    @Param('id') id: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<OwnerListing> {
    const listing = await this.listings.findOwned(id, owner.id);
    if (listing === null) throw new NotFoundException();

    return toOwnerListing(listing);
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
 * The owner's projection.
 *
 * `ownerId` is deliberately dropped: this shape is only ever served to the owner
 * themselves, so echoing their own id back adds nothing — and it is one fewer
 * field to remember to strip when 2.10 adds the public projection beside it.
 */
function toOwnerListing(listing: ListingRecord): OwnerListing {
  return {
    id: listing.id,
    categorySlug: listing.categorySlug,
    categoryName: listing.categoryName,
    categoryVersionNumber: listing.categoryVersionNumber,
    title: listing.title,
    description: listing.description,
    replacementValue: listing.replacementValue,
    status: listing.status,
    createdAt: Time.toIsoUtc(listing.createdAt),
    updatedAt: Time.toIsoUtc(listing.updatedAt),
  };
}
