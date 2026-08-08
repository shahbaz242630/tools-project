import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_FEATURE_FLAGS_ROUTE,
  ADMIN_FEATURE_FLAG_ROUTE,
  ContractViolationError,
  parseAdminReason,
  parseFeatureFlagChange,
} from '@platform/contracts';
import type { AdminFeatureFlag } from '@platform/contracts';
import { AuthGuard, Roles } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import type { MirroredUser } from '../identity/user-directory.js';
import type { Actor } from '../audit/audit-log.js';
import { FEATURE_FLAGS_SERVICE } from './feature-flags.tokens.js';
import type { FeatureFlagsService } from './feature-flags.service.js';

/**
 * Feature flags, as an administrator operates them.
 *
 * Every route is `@Roles('ADMIN')`, so a recently verified second factor is
 * required by the guard rather than by anything written here (ADR 0021). That
 * matters more on this controller than on any other in the application: it is
 * the one surface where a single request changes what the platform does **for
 * everybody at once**, with no dual approval in front of it.
 *
 * **The write takes a reason and the read does not**, matching
 * `admin-categories.controller.ts`. A flag has no subject whose personal data is
 * disclosed by looking at it, so demanding a reason to read the list would be a
 * ritual — and a ritual is what turns a mandatory field into a meaningless one.
 * Changing one is different in kind, and §9 requires it recorded.
 *
 * **There is deliberately no dual approval here, and that is a judgement rather
 * than an omission.** ADR 0023 requires two administrators for a role change,
 * because that grants standing power and there is never a reason it cannot wait.
 * A kill switch is the opposite: §9 asks for *rapid* disablement, and a control
 * that needs a second person is unavailable at 3am to the one person who is
 * awake. The compensating control is that every change is audited and logged
 * loudly, and that the blast radius is a feature rather than an account.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminFeatureFlagsController {
  constructor(
    @Inject(FEATURE_FLAGS_SERVICE) private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * Every flag this build declares, with its effective value.
   *
   * Driven by the declaration rather than by the stored rows, so a flag nobody
   * has ever switched still appears — an administrator needs every switch that
   * exists, not only the ones already used.
   */
  @Get(ADMIN_FEATURE_FLAGS_ROUTE)
  @Roles('ADMIN')
  async list(): Promise<{ readonly flags: readonly AdminFeatureFlag[] }> {
    return { flags: await this.flags.list() };
  }

  /**
   * Switch a flag.
   *
   * **`PUT`, not `POST`, and it is idempotent**: sending `enabled: false` twice
   * leaves the same state and writes a second audit entry saying somebody
   * confirmed it. That is the right shape for a control somebody reaches for
   * under pressure — a kill switch that errors because it was already thrown is
   * one that makes an incident worse.
   *
   * 404 for a key this build does not declare, rather than creating a row.
   * Storing an unknown key would put a switch on this page that gates nothing,
   * which is the dead control the closed vocabulary exists to prevent
   * (ADR 0036).
   */
  @Put(ADMIN_FEATURE_FLAG_ROUTE)
  @Roles('ADMIN')
  async set(
    @Param('key') key: string,
    @Body() body: unknown,
    @Query('reason') reason: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminFeatureFlag> {
    const change = parse(() => parseFeatureFlagChange(body));
    const why = parse(() => parseAdminReason(reason));

    const updated = await this.flags.set(
      actorOf(admin, request),
      key,
      change.enabled,
      why,
    );
    if (updated === null) throw new NotFoundException();

    return updated;
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

function actorOf(admin: MirroredUser, request: AuthenticatedRequest): Actor {
  return {
    userId: admin.id,
    ipAddress: request.clientIp ?? null,
    sessionId: request.sessionId ?? null,
  };
}
