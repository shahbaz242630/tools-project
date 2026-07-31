import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ADMIN_ACTIVITY_ROUTE, parseAdminReason } from '@platform/contracts';
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
      actor: { userId: admin.id, ipAddress: request.clientIp ?? null },
      action: 'admin.activity_viewed',
      targetType: 'user',
      targetId: userId,
      reason,
    });

    const entries = await this.audit.listForActor(userId);

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        targetType: entry.targetType,
        reason: entry.reason,
        ipAddress: entry.ipAddress,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }
}
