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
  UseGuards,
} from '@nestjs/common';
import {
  CATEGORY_OPTIONS_ROUTE,
  ContractViolationError,
  LISTINGS_ROUTE,
  LISTING_ROUTE,
  describeAttributeIssue,
  parseListingDraft,
} from '@platform/contracts';
import type { CategoryOption, OwnerListing } from '@platform/contracts';
import { Time } from '@platform/core';
import { AllowsSuspended, AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { LISTINGS_SERVICE } from './catalogue.tokens.js';
import { CategoryChangedError, UnknownCategoryError } from './listing-store.js';
import type { ListingRecord } from './listing-store.js';
import {
  AttributeValuesInvalidError,
  TransportRequirementNotOfferedError,
} from './listings.service.js';
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
        attributes: draft.attributes,
        transportRequirement: draft.transportRequirement,
        requiresTwoPersonLift: draft.requiresTwoPersonLift,
        collectionLocation: draft.collectionLocation,
        categoryVersionNumber: draft.categoryVersionNumber,
      });
      return toOwnerListing(created);
    } catch (error) {
      if (error instanceof UnknownCategoryError) {
        // 404 rather than 400: the body is well formed and the category was
        // real when the form was rendered. The fix is to choose again, not to
        // correct a field.
        throw new NotFoundException({ message: error.message });
      }
      if (error instanceof CategoryChangedError) {
        // 409 rather than 400: nothing they typed is wrong and there is no
        // field to correct. The configuration moved underneath them, which is a
        // conflict about state rather than a fault in the request.
        throw new ConflictException({ message: error.message });
      }
      if (error instanceof TransportRequirementNotOfferedError) {
        // 400, not 409. The category has not moved — the version check above
        // would have caught that — so this is a value the form should never have
        // offered, and the message names what it does offer.
        throw new BadRequestException({
          message: 'That is not how items in this category are collected',
          issues: [error.message],
        });
      }
      if (error instanceof AttributeValuesInvalidError) {
        // The same shape a contract violation produces, so the web app has one
        // way of reading "the API rejected these fields" rather than two.
        throw new BadRequestException({
          message: 'Some of the details for this category were not accepted',
          issues: error.issues.map(describeAttributeIssue),
        });
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
    // The schema **as pinned**, not as the category stands now. A stored `25`
    // is unreadable without something saying it is kilograms at one decimal
    // place, and sending today's schema would render last month's answers under
    // labels they were never given.
    categoryAttributes: listing.categoryAttributes,
    title: listing.title,
    description: listing.description,
    replacementValue: listing.replacementValue,
    attributes: listing.attributes,
    transportRequirement: listing.transportRequirement,
    requiresTwoPersonLift: listing.requiresTwoPersonLift,
    // In full, because this shape reaches nobody but the owner who typed it.
    // 2.10 builds a different projection for strangers, carrying the outward
    // code and the town — BRD §8.4.1's rule, kept as a type rather than as a
    // field somebody has to remember to delete.
    collectionLocation: listing.collectionLocation,
    // Whether, not where. The coordinates stop at the store (§8.4.1) — there is
    // no field on `ListingRecord` that could leak them, which is a stronger
    // guarantee than remembering not to map one.
    isLocated: listing.isLocated,
    status: listing.status,
    createdAt: Time.toIsoUtc(listing.createdAt),
    updatedAt: Time.toIsoUtc(listing.updatedAt),
  };
}
