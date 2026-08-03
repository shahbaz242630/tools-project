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
import {
  ADMIN_ACTIVITY_ROUTE,
  isAccountId,
  parseAdminReason,
} from '@platform/contracts';
import { ContractViolationError } from '@platform/contracts';
import type { ActivityResponse } from '@platform/contracts';
import { AuthGuard, Roles } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import type { MirroredUser } from '../identity/user-directory.js';
import type { AuditService } from './audit.service.js';
import { AUDIT_SERVICE } from './audit.tokens.js';

/**
 * An administrator reading somebody else's activity.
 *
 * The first administrative capability in the application, and it is deliberately
 * a *read* — BRD §8.13 permits read-only support access from Phase 1 and
 * prohibits write-capable impersonation at launch.
 *
 * Three things guard it, and all three are required:
 *
 *   - `@Roles('ADMIN')`, which also forces a recently verified second factor.
 *     The guard couples them so an admin route cannot exist without MFA.
 *   - A **reason**, without which the request is refused. BRD §8.13: "Every
 *     admin action records actor, reason, target and before/after state."
 *   - Its own audit entry, because an administrator reading somebody's history
 *     is a disclosure, and the person it happened to should be able to see it.
 *
 * That last point is why the reason reaches the audit trail rather than only a
 * log: the subject can read it on their own activity page.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminActivityController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  @Get(ADMIN_ACTIVITY_ROUTE)
  @Roles('ADMIN')
  async list(
    @Param('userId') userId: string,
    @Query('reason') rawReason: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ActivityResponse> {
    // Before anything is written. `audit_logs.targetId` is a `uuid` column, so
    // recording a malformed path parameter makes the insert throw — and because
    // audit writes are fail-closed, that throw becomes a 500 on the very action
    // it was supposed to record. 404 rather than 400, matching the public
    // profile route: "that is not an id" and "no such account" are the same
    // answer to a caller.
    if (!isAccountId(userId)) {
      throw new NotFoundException();
    }

    let reason: string;
    try {
      reason = parseAdminReason(rawReason);
    } catch (error) {
      if (error instanceof ContractViolationError) {
        throw new BadRequestException({
          message: 'A reason is required to view another account’s activity',
          issues: error.issues,
        });
      }
      throw error;
    }

    // Recorded before the read, so a disclosure cannot happen without the
    // record of it — the same ordering as the export (ADR 0019). The actor is
    // the administrator; the target is the account they looked at.
    await this.audit.record({
      actor: {
        userId: admin.id,
        ipAddress: request.clientIp ?? null,
        sessionId: request.sessionId ?? null,
      },
      action: 'admin.activity_viewed',
      targetType: 'user',
      targetId: userId,
      reason,
    });

    // The same merged trail the account holder sees on their own page, and
    // deliberately so: a support view that showed *less* than the person can
    // see themselves makes every enquiry start with the two sides describing
    // different histories. It includes the disclosure recorded a moment ago,
    // which reads oddly for a line and then stops — an administrator watching
    // their own access appear is the control working, not noise.
    const entries = await this.audit.listActivityFor(userId);

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        targetType: entry.targetType,
        by: entry.by,
        reason: entry.reason,
        ipAddress: entry.ipAddress,
        // **Withheld here, unlike on the person's own page**, and this is the
        // one place this route serves less than the account holder sees.
        //
        // ADR 0022 made the administrative projection the narrowest thing that
        // helps support, and ADR 0025 refused an administrative view of
        // somebody's sign-ins outright — a location and device history is not
        // in the category of thing support needs. A raw session id is a
        // correlation handle over exactly that: it groups an account's actions
        // into sittings, and repeated across a trail it describes when and how
        // often somebody uses the platform.
        //
        // It would also buy support nothing. Resolving one to a device needs the
        // sign-in list, which an administrator has no route to, so the column
        // would render as an opaque `sess_…` on every row.
        sessionId: null,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }
}
