import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ADMIN_USER_ROUTE, isAccountId, parseAdminReason } from '@platform/contracts';
import { ContractViolationError } from '@platform/contracts';
import type { AdminUserView } from '@platform/contracts';
import { AuthGuard, Roles } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import { ACCOUNT_ADMIN_SERVICE } from './identity.tokens.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import type { AccountAdminService } from './account-admin.service.js';
import type { MirroredUser } from './user-directory.js';

/**
 * An administrator reading somebody's account state.
 *
 * BRD §8.13's read-only "view as user", and read-only in the strongest sense
 * available: it is a **projection**, not a session. Nothing here mints a token
 * as another person, the administrator's own session stays their own, and there
 * is no request shape that could change anything. Write-capable impersonation
 * is prohibited at launch and the cheapest way to honour that is to build no
 * mechanism for it (ADR 0022).
 *
 * Guarded exactly like the activity disclosure beside it: `@Roles('ADMIN')`,
 * which also forces a recently verified second factor; a mandatory reason; and
 * its own audit entry, written before the read and visible to the person whose
 * account was read.
 *
 * **The page does not check the role and this does.** A check in the web app
 * would be a second place for the rule to live and the easier of the two to get
 * wrong, and hiding a form protects nothing when the endpoint holds the data.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminUserController {
  constructor(
    @Inject(ACCOUNT_ADMIN_SERVICE) private readonly identity: AccountAdminService,
  ) {}

  @Get(ADMIN_USER_ROUTE)
  @Roles('ADMIN')
  async find(
    @Param('userId') userId: string,
    @Query('reason') rawReason: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminUserView> {
    // Before anything is written. `audit_logs.targetId` is a `uuid` column and
    // the disclosure is recorded before the read, so an unvalidated path
    // parameter throws on the insert — and a fail-closed audit write turns that
    // into a 500 on the action it was meant to record.
    if (!isAccountId(userId)) {
      throw new NotFoundException();
    }

    let reason: string;
    try {
      reason = parseAdminReason(rawReason);
    } catch (error) {
      if (error instanceof ContractViolationError) {
        throw new BadRequestException({
          message: 'A reason is required to view another account',
          issues: error.issues,
        });
      }
      throw error;
    }

    const view = await this.identity.adminViewFor(
      {
        userId: admin.id,
        ipAddress: request.clientIp ?? null,
        sessionId: request.sessionId ?? null,
      },
      userId,
      reason,
    );

    // A well-formed id for an account that does not exist. The audit entry is
    // already written and stays written — an administrator asking after an id
    // is a real event, and a trail that recorded only the successful lookups
    // would be the wrong half.
    if (view === null) {
      throw new NotFoundException();
    }

    return view;
  }
}
