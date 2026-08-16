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
import type { AdminCategory, CategoryConfigurationInput } from '@platform/contracts';
import { Time } from '@platform/core';
import { AuthGuard, Roles } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import type { MirroredUser } from '../identity/user-directory.js';
import type { Actor } from '../audit/audit-log.js';
import { CATALOGUE_SERVICE } from './catalogue.tokens.js';
import { CategorySlugTakenError } from './category-store.js';
import type { CategoryConfiguration, CategoryRecord } from './category-store.js';
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

  /**
   * One category by slug. **Nothing calls this, and it is kept deliberately.**
   *
   * The admin surface is a single page listing every category with its forms
   * inline (`app/admin/categories/page.tsx`), and the list route above already
   * returns the whole `AdminCategory`, so a caller holding a slug is a caller
   * that already has the object. `apps/web/src/lib/admin-categories.ts` uses
   * this path for the `PUT` and never for the `GET`. It was found unused in the
   * August 2026 audit and this comment is the decision, not an oversight.
   *
   * **Why it is not deleted, given this project deletes features built for
   * callers who do not exist** (slice 2.11): that rule is about work whose
   * consumer will *never* exist — a concierge flow needing staff we will never
   * hire. This is the read half of a read/write pair whose write half is live,
   * and it cannot rot in the way dead code rots, because both routes project
   * through the one `toAdminCategory` below. A field added to `AdminCategory`
   * reaches both or neither, and their tests fail together. It is also what
   * `categories.integration.test.ts` reads a configuration back through, so it
   * is exercised on every run rather than merely compiled.
   *
   * **What would delete it:** an admin surface that still has no per-category
   * page by the time the first rate limits land (BRD §10), at which point this
   * becomes one more authenticated route needing a budget nobody can size from
   * traffic that does not exist. Deleting it then also means deleting
   * `CatalogueService.findBySlug`, whose only production caller it is.
   */
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
      const created = await this.catalogue.create(
        actorOf(admin, request),
        { ...configurationOf(draft), slug: draft.slug },
        why,
      );
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
      configurationOf(configuration),
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

/**
 * What actually gets stored, with `reportingDutiesAcknowledged` dropped.
 *
 * Spelled out field by field rather than spread, because the whole point is that
 * one field of a validated body does **not** travel any further. The
 * acknowledgement is an assertion about this request — the contract has already
 * refused the request if it was missing — and storing it would record a value
 * that is true of every row by construction. What survives is the audit entry.
 *
 * Structural typing would have let the whole body through to the store without
 * complaint, and the store would have ignored the extra field silently. That is
 * precisely why this is explicit: a future field added to the request and not to
 * the configuration should be a decision, not an accident of which object was
 * nearest.
 */
function configurationOf(body: CategoryConfigurationInput): CategoryConfiguration {
  return {
    name: body.name,
    riskLevel: body.riskLevel,
    reportableActivity: body.reportableActivity,
    attributes: body.attributes,
    transportOptions: body.transportOptions,
    feePolicy: body.feePolicy,
    maximumRentalDays: body.maximumRentalDays,
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
    reportableActivity: category.reportableActivity,
    attributes: category.attributes,
    transportOptions: category.transportOptions,
    feePolicy: category.feePolicy,
    maximumRentalDays: category.maximumRentalDays,
    versionNumber: category.versionNumber,
    versionCreatedAt: Time.toIsoUtc(category.versionCreatedAt),
    createdAt: Time.toIsoUtc(category.createdAt),
  };
}
