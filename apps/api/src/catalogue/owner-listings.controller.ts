import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
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
  parseListingEdit,
} from '@platform/contracts';
import type {
  CategoryOption,
  OwnedListings,
  OwnerListing,
  OwnerListingSummary,
} from '@platform/contracts';
import { Time } from '@platform/core';
import { inclusiveDailyPrice } from '../pricing/daily-price.js';
import {
  ListingNotPublishableError,
  ListingTransitionRefusedError,
  PublicationSuspendedError,
  PublishedListingIncompleteError,
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
      return toOwnerListing(created, await this.listings.isPublicationAvailable());
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
   * Everything you have listed (slice 2.9a).
   *
   * **The projection is narrower than the one below serves for a single
   * listing**, and that is the security half of this route rather than a
   * rendering preference. `OwnerListing` carries the decrypted collection
   * address; this list would otherwise return one street address per row to
   * render a page that shows none. `toOwnerListingSummary` is a separate
   * function for the same reason `ListingStore` has no `findById` — the narrow
   * shape has to be the one that is *available*, not the one somebody remembers
   * to build.
   *
   * **`@AllowsSuspended()`.** Reading what we hold about you survives suspension
   * (ADR 0024), and this is the read that makes the rest reachable — a suspended
   * owner who cannot find their own listings cannot pause one, which is a write
   * ADR 0024 deliberately leaves open to them.
   *
   * No pagination parameter. The bound is `OWNED_LISTING_LIMIT` and the response
   * says when it was reached; a `?limit=` a caller may set is one a caller may
   * set to anything, and there is nothing yet for a second page to mean.
   */
  @Get(LISTINGS_ROUTE)
  @AllowsSuspended()
  async list(@CurrentUser() owner: MirroredUser): Promise<OwnedListings> {
    const page = await this.listings.listOwned(owner.id);

    return {
      listings: page.items.map(toOwnerListingSummary),
      truncated: page.truncated,
    };
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

    return toOwnerListing(listing, await this.listings.isPublicationAvailable());
  }

  /**
   * Rewrite a listing (§8.3, slice 2.9b-i, ADR 0042).
   *
   * **`PUT`, not `PATCH`**, and the body carries every field. A partial is a
   * shape where "absent" and "clear this" are the same value on the wire, and
   * the field that would suffer is a description somebody spent an evening on.
   *
   * **Not `@AllowsSuspended()`.** ADR 0024's line is that a suspended account may
   * read what we hold and may not write anything others would see. Editing a
   * *published* listing changes what strangers see, so it sits with publishing
   * rather than with pausing — the one write on this controller that makes others
   * see *less* and is therefore allowed.
   *
   * The failure translations are `create`'s, deliberately: an owner correcting a
   * listing meets the same category, the same schema and the same stale-form race
   * as one writing a new one, and two routes explaining the same refusal
   * differently is how a client comes to handle only one of them.
   */
  @Put(LISTING_ROUTE)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() owner: MirroredUser,
  ): Promise<OwnerListing> {
    const edit = parse(() => parseListingEdit(body));

    try {
      const updated = await this.listings.edit(id, owner.id, {
        title: edit.title,
        description: edit.description,
        replacementValue: edit.replacementValue,
        attributes: edit.attributes,
        transportRequirement: edit.transportRequirement,
        requiresTwoPersonLift: edit.requiresTwoPersonLift,
        rates: edit.rates,
        collectionLocation: edit.collectionLocation,
        categoryVersionNumber: edit.categoryVersionNumber,
      });
      if (updated === null) throw new NotFoundException();

      return toOwnerListing(updated, await this.listings.isPublicationAvailable());
    } catch (error) {
      if (error instanceof CategoryChangedError) {
        throw new ConflictException({ message: error.message });
      }
      if (error instanceof PublishedListingIncompleteError) {
        /*
         * **422 with the same `blockers` shape publishing uses** (slice 2.9b-ii),
         * so a client already rendering "what is left to do" needs no second
         * code path. The *message* differs because the situation does: publishing
         * says the listing is not ready yet, and this says it is already live and
         * the save would break it.
         *
         * It names pausing, because that is the one action that makes the change
         * legitimate rather than merely refused — an owner emptying the address of
         * a listing they no longer want to rent out is not doing anything wrong,
         * they are doing it in the wrong order.
         */
        throw new UnprocessableEntityException({
          message:
            'This listing is published, and that change would leave it ' +
            'incomplete. Put back what is missing, or pause the listing first ' +
            'and then make the change.',
          blockers: error.blockers,
        });
      }
      if (error instanceof TransportRequirementNotOfferedError) {
        throw new BadRequestException({
          message: 'That is not how items in this category are collected',
          issues: [error.message],
        });
      }
      if (error instanceof AttributeValuesInvalidError) {
        throw new BadRequestException({
          message: 'Some of the details for this category were not accepted',
          issues: error.issues.map(describeAttributeIssue),
        });
      }
      throw error;
    }
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

      // Read rather than assumed `true`. Publishing succeeded a moment ago, so
      // it was on then — but this field describes now, and a value that is
      // right by coincidence is one that stops being right when the code around
      // it moves.
      return toOwnerListing(published, await this.listings.isPublicationAvailable());
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
      throwRefusalAsConflict(error);
    }
  }

  /**
   * Take a listing out of public view (§8.3, slice 2.8b).
   *
   * **`DELETE` on the publication rather than `POST /pause`.** Pausing is
   * removing the publication this path already names, and the verb pair says
   * which two operations are opposites in a way a second noun could not.
   *
   * **No kill-switch case here.** The switch stops listings going public; it has
   * no business stopping an owner taking one down, and an incident is exactly
   * when somebody most needs to be able to. So this route has no 503 branch —
   * not because one was forgotten, but because the service never raises it.
   *
   * **`@AllowsSuspended()`, unlike publishing, and the asymmetry is the rule
   * rather than an exception to it.** ADR 0024 stops a suspended account writing
   * anything others would see. Pausing is the only write on this controller that
   * makes strangers see *less*, and refusing it would leave a suspended owner
   * unable to withdraw their own item while it stayed live — punishing them by
   * forcing publication, which is not what a suspension is for. It sits with
   * export and deletion, which ADR 0024 also keeps available.
   */
  @Delete(LISTING_PUBLICATION_ROUTE)
  @AllowsSuspended()
  async pause(
    @Param('id') id: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<OwnerListing> {
    try {
      const paused = await this.listings.pause(id, owner.id);
      if (paused === null) throw new NotFoundException();

      return toOwnerListing(paused, await this.listings.isPublicationAvailable());
    } catch (error) {
      throwRefusalAsConflict(error);
    }
  }
}

/**
 * An illegal transition as a 409, or the original error untouched.
 *
 * **409 rather than 422, and the pair is the point.** 422 says the state of the
 * listing is wrong in a way its owner can put right, and it carries the list of
 * what to fix. 409 says the request does not apply to a listing in this state at
 * all — there is no field to add and no list to show, and pausing a draft will
 * not become possible by supplying anything. A client that could not tell them
 * apart would render an empty checklist under "here is what is left to do".
 */
function throwRefusalAsConflict(error: unknown): never {
  if (error instanceof ListingTransitionRefusedError) {
    throw new ConflictException({ message: error.refusal });
  }
  throw error;
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
 * The owner's projection, one row at a time (slice 2.9a).
 *
 * **Built field by field from the record rather than by deleting from
 * `toOwnerListing`'s result**, which is the whole reason it is a separate
 * function. A `delete summary.collectionLocation` — or a spread with an omission
 * — is a line somebody removes while tidying, and what it removes is a
 * disclosure. Listing the nine fields that belong here means a tenth arrives
 * only when somebody types it.
 *
 * `publicationAvailable` is absent too, and that one is not about privacy: it is
 * a platform-wide fact, identical on every row, and repeating it two hundred
 * times would invite a list that renders it per listing as though it varied.
 * The button it governs is on the listing's own page.
 */
function toOwnerListingSummary(listing: ListingRecord): OwnerListingSummary {
  return {
    id: listing.id,
    title: listing.title,
    categoryName: listing.categoryName,
    status: listing.status,
    // Both authorities travel, because `isPubliclyVisible` needs both and a list
    // is where showing `status` alone would be least likely to be noticed
    // (ADR 0041).
    moderationState: listing.moderationState,
    isLocated: listing.isLocated,
    // Computed here, as it is on the single-listing projection, and against the
    // category's **current** fee policy (ADR 0042). §3.4.4 names listing cards
    // explicitly, and the bare rate is deliberately not on this shape at all.
    inclusiveDailyPrice: inclusiveDailyPrice(listing.rates, listing.currentFeePolicy),
    createdAt: Time.toIsoUtc(listing.createdAt),
    updatedAt: Time.toIsoUtc(listing.updatedAt),
  };
}

/**
 * The owner's projection.
 *
 * `ownerId` is deliberately dropped: this shape is only ever served to the owner
 * themselves, so echoing their own id back adds nothing — and it is one fewer
 * field to remember to strip when 2.10 adds the public projection beside it.
 */
function toOwnerListing(
  listing: ListingRecord,
  /**
   * Whether the platform is accepting publications (slice H3b).
   *
   * **A required parameter rather than a field on `ListingRecord`.** It is not a
   * property of the row and never comes back from the store, so putting it on
   * the record would mean inventing a value in the adapter. Required rather than
   * defaulted because a default is what a call site forgets, and the forgotten
   * value here would tell an owner the button works when it does not.
   */
  publicationAvailable: boolean,
): OwnerListing {
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
     * Computed against the category's **current** fee policy, not the version
     * this listing pinned (ADR 0042) — and this comment said the exact opposite
     * until slice 2.7c. The rule it cited is real and belongs to a **booking**,
     * which retains the terms it was made under; a listing is an offer, and
     * §3.4.4 wants the price on an offer to be the price payable today. Pinning
     * it here also meant an owner editing their title silently changed what they
     * are paid, which is what settled it.
     */
    inclusiveDailyPrice: inclusiveDailyPrice(listing.rates, listing.currentFeePolicy),
    status: listing.status,
    /*
     * **Both authorities, because visibility takes both** (ADR 0041, 2.8c-ii).
     *
     * These two lines are the whole of this slice's server half, and the reason
     * they were missing is worth keeping: 2.8c-i added the state, the column, the
     * constraint and the route, and stopped at the boundary of what an
     * *administrator* could do. The owner's projection was never touched, so the
     * platform could hide somebody's listing and the only page they can see went
     * on calling it published.
     *
     * The reason travels **as written**. ADR 0024's rule for suspension, and the
     * moderation form's own promise to whoever types it.
     */
    moderationState: listing.moderationState,
    moderationReason: listing.moderationReason,
    publicationAvailable,
    createdAt: Time.toIsoUtc(listing.createdAt),
    updatedAt: Time.toIsoUtc(listing.updatedAt),
  };
}
