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
  Put,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  ContractViolationError,
  LISTING_MEDIA_ITEM_ROUTE,
  LISTING_MEDIA_ORDER_ROUTE,
  LISTING_MEDIA_ROUTE,
  parseListingMediaOrder,
} from '@platform/contracts';
import type { OwnerListingMedia } from '@platform/contracts';
import { AllowsSuspended, AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { RateLimit, RateLimitGuard } from '../rate-limiting/rate-limit.guard.js';
import { LISTING_MEDIA_SERVICE } from './catalogue.tokens.js';
import { ListingMediaRefusedError } from './listing-media.service.js';
import type { ListingMediaService } from './listing-media.service.js';

/**
 * An owner's photographs of their own item (BRD §6.2, slice 2.6b-i).
 *
 * **Its own controller rather than three more routes on
 * `OwnerListingsController`**, and the reason is mechanical rather than
 * aesthetic. `@RateLimit` is a method decorator but `RateLimitGuard` is applied
 * to the *class*, and `decorated-routes.test.ts` requires that any class holding
 * a `@RateLimit` carries both guards. Adding the guard to the listings
 * controller would put six unrelated routes — create, read, list, edit, publish,
 * pause — under a limiter in the same commit, each needing a tier decision
 * nobody asked for. Splitting keeps that decision where it belongs.
 *
 * **404 for somebody else's listing, never 403**, on every route. A 403 confirms
 * the listing exists, which is the thing the check protects.
 *
 * **No route here is public and none should be.** A photograph reaches a
 * stranger through the public listing projection in 2.6b-ii, which mints its own
 * signed URLs from a listing it has already decided may be shown.
 */
@Controller()
@UseGuards(AuthGuard, RateLimitGuard)
export class OwnerListingMediaController {
  constructor(
    @Inject(LISTING_MEDIA_SERVICE)
    private readonly media: ListingMediaService,
  ) {}

  /**
   * This listing's photographs.
   *
   * **`@AllowsSuspended()`.** Reading back what we hold about you survives
   * suspension (ADR 0024), and these are the owner's own pictures.
   */
  @RateLimit('read')
  @Get(LISTING_MEDIA_ROUTE)
  @AllowsSuspended()
  async list(
    @Param('id') listingId: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<{ media: readonly OwnerListingMedia[] }> {
    const media = await this.media.listFor(listingId, owner.id);
    if (media === null) throw new NotFoundException();

    return { media };
  }

  /**
   * Add a photograph.
   *
   * **The body is the image itself — raw bytes, `application/octet-stream`.**
   * There is no multipart parser on this API and deliberately none: multipart
   * exists to carry several named parts, and this request has exactly one thing
   * in it. The filename is not wanted (the file is re-encoded and the original
   * name discarded), and no other field belongs here. The browser's multipart
   * form is parsed by the Next route handler in front, which is the only thing a
   * browser can reach.
   *
   * `@Req()` rather than `@Body()`: the raw-body parser registered in `main.ts`
   * hands Fastify a `Buffer`, and Nest's `@Body()` would be typed `unknown` and
   * invite a `parse()` that has nothing to parse.
   *
   * **Not `@AllowsSuspended()`.** A suspended account may read what we hold and
   * may not add to what we publish (ADR 0024).
   */
  @RateLimit('write')
  @Post(LISTING_MEDIA_ROUTE)
  async add(
    @Param('id') listingId: string,
    @CurrentUser() owner: MirroredUser,
    @Req() request: { body?: unknown },
  ): Promise<OwnerListingMedia> {
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes)) {
      // Reached when the content type was not the one the raw parser is
      // registered for, so Fastify parsed the body as something else. A 400
      // rather than a 415: the caller sent a request this route cannot read, and
      // the sentence tells them what it wanted.
      throw new BadRequestException({
        message:
          'Send the image as the request body with content-type application/octet-stream',
      });
    }

    try {
      const added = await this.media.add(listingId, owner.id, bytes);
      if (added === null) throw new NotFoundException();
      return added;
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Remove a photograph.
   *
   * 404 both when the listing is not this owner's and when it holds no such
   * photograph — the service distinguishes them and the wire deliberately does
   * not, because the difference is only interesting to somebody probing for ids.
   */
  @RateLimit('write')
  @Delete(LISTING_MEDIA_ITEM_ROUTE)
  @HttpCode(204)
  async remove(
    @Param('id') listingId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() owner: MirroredUser,
  ): Promise<void> {
    const removed = await this.media.remove(listingId, owner.id, mediaId);
    if (removed === null || !removed) throw new NotFoundException();
  }

  /**
   * Put the photographs in a given order.
   *
   * `PUT`, because the order replaces whatever the previous one was rather than
   * amending it — the same reason `ADMIN_LISTING_MODERATION_ROUTE` is a `PUT`.
   */
  @RateLimit('write')
  @Put(LISTING_MEDIA_ORDER_ROUTE)
  async reorder(
    @Param('id') listingId: string,
    @CurrentUser() owner: MirroredUser,
    @Body() body: unknown,
  ): Promise<{ media: readonly OwnerListingMedia[] }> {
    const order = parse(() => parseListingMediaOrder(body));

    try {
      const media = await this.media.reorder(listingId, owner.id, order.mediaIds);
      if (media === null) throw new NotFoundException();
      return { media };
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * One place for the contract-violation translation, so no route can 500 on one.
 *
 * Copied rather than shared with `owner-listings.controller.ts`: a helper
 * exported across controllers would be a shared dependency between two modules'
 * HTTP layers, and it is four lines.
 */
function parse<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ContractViolationError) {
      throw new BadRequestException({
        message: error.message,
        issues: error.issues,
      });
    }
    throw error;
  }
}

/**
 * A refusal from the service, as a status code.
 *
 * **422 for a file we will not store, 503 for a store that would not take it**,
 * and the split matters to whoever is looking at a dashboard: the first is the
 * caller's problem and is not worth an alert, the second is ours and is.
 * `ObjectStoreUnavailableError` is documented as always transient, so it takes
 * the same 503 branch `PublicationSuspendedError` does.
 *
 * The reason travels with the message so a page can say *why* rather than
 * "something went wrong" — it is a closed union precisely so it can be shown and
 * counted.
 */
function translate(error: unknown): unknown {
  if (!(error instanceof ListingMediaRefusedError)) return error;

  if (error.reason === 'storage-unavailable') {
    return new ServiceUnavailableException({
      message: error.message,
      reason: error.reason,
    });
  }

  return new UnprocessableEntityException({
    message: error.message,
    reason: error.reason,
  });
}
