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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_CATEGORIES_ROUTE,
  ADMIN_CATEGORY_ROUTE,
  ContractViolationError,
  parseAdminReason,
  parseCategoryConfiguration,
  parseCategoryDraft,
} from '@platform/contracts';
import type { AdminCategory } from '@platform/contracts';
import { Time } from '@platform/core';
import { AuthGuard, Roles } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import type { MirroredUser } from '../identity/user-directory.js';
import type { Actor } from '../audit/audit-log.js';
import { CATALOGUE_SERVICE } from './catalogue.tokens.js';
import { CategorySlugTakenError } from './category-store.js';
import type { CategoryRecord } from './category-store.js';
import type { CatalogueService } from './catalogue.service.js';

/**
 * Categories, as an administrator manages them.
 *
 * Every route is `@Roles('ADMIN')`, so a recently verified second factor is
 * required by the guard rather than by anything written here (ADR 0021). A
 * suspended administrator cannot reach any of it either: no admin route opts in
 * to `@AllowsSuspended`.
 *
 * **The writes take a reason and the reads do not**, which is a narrower rule
 * than the admin surface in `identity/` follows. There, a read is a disclosure
 * of somebody's personal data and owes an explanation to the person it is
 * about. A category has no subject — it is configuration, and from slice 2.10 it
 * is public — so demanding a reason to look at one would be a ritual, and a
 * ritual is what turns a mandatory field into a meaningless one. Changing
 * configuration every later booking is interpreted under is a different matter,
 * and §8.2 requires those to be audited.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminCategoriesController {
  constructor(
    @Inject(CATALOGUE_SERVICE) private readonly catalogue: CatalogueService,
  ) {}

  @Get(ADMIN_CATEGORIES_ROUTE)
  @Roles('ADMIN')
  async list(): Promise<{ readonly categories: readonly AdminCategory[] }> {
    const categories = await this.catalogue.list();
    return { categories: categories.map(toAdminCategory) };
  }

  @Get(ADMIN_CATEGORY_ROUTE)
  @Roles('ADMIN')
  async read(@Param('slug') slug: string): Promise<AdminCategory> {
    const category = await this.catalogue.findBySlug(slug);
    if (category === null) throw new NotFoundException();
    return toAdminCategory(category);
  }

  @Post(ADMIN_CATEGORIES_ROUTE)
  @Roles('ADMIN')
  async create(
    @Body() body: unknown,
    @Query('reason') reason: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminCategory> {
    const draft = parse(() => parseCategoryDraft(body));
    const why = parse(() => parseAdminReason(reason));

    try {
      const created = await this.catalogue.create(actorOf(admin, request), draft, why);
      return toAdminCategory(created);
    } catch (error) {
      if (error instanceof CategorySlugTakenError) {
        // 409, not 400. The body is well formed; the state of the world refuses
        // it, and the fix is a different slug rather than a corrected field.
        throw new ConflictException({ message: error.message });
      }
      throw error;
    }
  }

  /**
   * Replace a category's configuration, minting a new version.
   *
   * `PUT` rather than `PATCH`, and the body carries every configurable field.
   * A partial update would have to merge against whatever the current version
   * happens to be at the moment the request lands, which makes two concurrent
   * edits produce a configuration neither administrator wrote. Sending the whole
   * configuration means the version that gets written is one somebody actually
   * saw.
   */
  @Put(ADMIN_CATEGORY_ROUTE)
  @Roles('ADMIN')
  async reconfigure(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Query('reason') reason: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminCategory> {
    const configuration = parse(() => parseCategoryConfiguration(body));
    const why = parse(() => parseAdminReason(reason));

    const updated = await this.catalogue.reconfigure(
      actorOf(admin, request),
      slug,
      configuration,
      why,
    );
    if (updated === null) throw new NotFoundException();

    return toAdminCategory(updated);
  }
}

/**
 * `Actor` itself, never a structural copy of it.
 *
 * `admin-suspension.controller` hand-wrote this shape and silently stopped
 * matching the moment `Actor` gained a field — a hand-written duplicate of a
 * security type drifts on exactly the field somebody added for a reason.
 */
function actorOf(admin: MirroredUser, request: AuthenticatedRequest): Actor {
  return {
    userId: admin.id,
    ipAddress: request.clientIp ?? null,
    sessionId: request.sessionId ?? null,
  };
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

function toAdminCategory(category: CategoryRecord): AdminCategory {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    riskLevel: category.riskLevel,
    attributes: category.attributes,
    versionNumber: category.versionNumber,
    versionCreatedAt: Time.toIsoUtc(category.versionCreatedAt),
    createdAt: Time.toIsoUtc(category.createdAt),
  };
}
