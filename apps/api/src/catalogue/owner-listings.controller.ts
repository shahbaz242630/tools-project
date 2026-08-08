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
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  CATEGORY_OPTIONS_ROUTE,
  ContractViolationError,
  LISTINGS_ROUTE,
  LISTING_PUBLICATION_ROUTE,
  LISTING_ROUTE,
  describeAttributeIssue,
  parseListingDraft,
} from '@platform/contracts';
import type { CategoryOption, OwnerListing } from '@platform/contracts';
import { Time } from '@platform/core';
import { inclusiveDailyPrice } from '../pricing/daily-price.js';
import {
  ListingNotPublishableError,
  PublicationSuspendedError,
} from './listings.service.js';
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
        rates: draft.rates,
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

  /**
   * Publish a listing (§8.3, slice 2.8a).
   *
   * **Not `@AllowsSuspended()`.** Reading your own listing while suspended is
   * right — ADR 0024 keeps a suspended account able to see and export its data.
   * Putting a new listing in front of strangers is not reading, and a suspended
   * owner doing it is the thing the suspension exists to stop.
   *
   * **422, not 400, when the listing is not ready.** The request is well formed
   * and coherent; what is wrong is the state of the listing, which no different
   * request body would fix. A client deciding between "show a field error" and
   * "show a list of what is left to do" needs those apart.
   */
  @Post(LISTING_PUBLICATION_ROUTE)
  async publish(
    @Param('id') id: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<OwnerListing> {
    try {
      const published = await this.listings.publish(id, owner.id);
      // Null for both "no such listing" and "not yours", so a stranger cannot
      // learn that somebody else's listing exists by trying to publish it.
      if (published === null) throw new NotFoundException();

      return toOwnerListing(published);
    } catch (error) {
      if (error instanceof PublicationSuspendedError) {
        /*
         * **503, not 422** (slice H3a). 422 means "the state of your listing is
         * wrong", and an owner reading one goes looking for the field to fix.
         * Nothing is wrong with their listing: the platform is not accepting
         * publications, it is temporary, and the same request will work later —
         * which is what 503 means and what `Retry-After` is for.
         *
         * No `blockers` array, deliberately, even though it would keep the shape
         * uniform. A client that reads `blockers` to decide what to show would
         * render an empty checklist, which reads as "nothing is wrong, and it
         * still refused".
         */
        throw new ServiceUnavailableException({
          message:
            'Publishing is temporarily switched off across the platform. ' +
            'Your listing is saved and unchanged — try again shortly.',
        });
      }
      if (error instanceof ListingNotPublishableError) {
        throw new UnprocessableEntityException({
          message: 'This listing is not ready to be published yet.',
          blockers: error.blockers,
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
    rates: listing.rates,
    /*
     * **The price is computed here and never by whatever renders it** (§6.1).
     *
     * Rounding lives in the pricing service and nowhere else, so a component
     * handed a rate and a fee percentage would be a second place a price is
     * worked out — which is how two surfaces come to disagree about what a thing
     * costs. It is also how drip pricing gets built by accident: with the bare
     * rate on the response and the fee somewhere else, showing the wrong one is
     * a single careless line, and §3.4.4 prohibits exactly that.
     *
     * Computed against the **pinned** version's fee policy, not the category's
     * current one (ADR 0029). Reconfiguring a category must not silently re-price
     * a listing that was written under different terms.
     */
    inclusiveDailyPrice: inclusiveDailyPrice(listing.rates, listing.categoryFeePolicy),
    status: listing.status,
    createdAt: Time.toIsoUtc(listing.createdAt),
    updatedAt: Time.toIsoUtc(listing.updatedAt),
  };
}
