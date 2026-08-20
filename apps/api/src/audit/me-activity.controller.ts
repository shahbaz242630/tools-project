import { RateLimit, RateLimitGuard } from '../rate-limiting/rate-limit.guard.js';
import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ME_ACTIVITY_PATH } from '@platform/contracts';
import type { ActivityResponse } from '@platform/contracts';
import { AllowsSuspended, AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { AuthenticatedRequest } from '../identity/auth.guard.js';
import type { MirroredUser } from '../identity/user-directory.js';
import type { AuditService } from './audit.service.js';
import { AUDIT_SERVICE } from './audit.tokens.js';

/**
 * The caller's own activity.
 *
 * No id in the path, the same reasoning as `/me/profile` and `/me`: an audit
 * trail is precisely the kind of thing where "may this person read that" must
 * not be a question somebody has to remember to ask. Taking the actor from the
 * verified session means there is no way to address anyone else's.
 *
 * There is deliberately no route here that reads *everyone's* entries. That is
 * an administrative capability and belongs with the admin role, its MFA
 * requirement and its own audit trail — not smuggled in as a query parameter.
 *
 * **It returns both directions**: what this person did, and what was done to
 * them. The second half is what makes BRD §8.13's reason requirement a control
 * rather than a note — an administrator's read is recorded against the
 * administrator, so before this it appeared in no page the subject could open.
 */
@Controller()
@UseGuards(AuthGuard, RateLimitGuard)
export class MeActivityController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  // Survives suspension, and it matters most then: this is where somebody sees
  // that an administrator suspended their account and the reason they gave.
  @RateLimit('read')
  @Get(ME_ACTIVITY_PATH)
  @AllowsSuspended()
  async list(
    @CurrentUser() user: MirroredUser,
    @Req() _request: AuthenticatedRequest,
  ): Promise<ActivityResponse> {
    const entries = await this.audit.listActivityFor(user.id);

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        targetType: entry.targetType,
        by: entry.by,
        // Visible to the person it happened to. Being able to read *why* an
        // administrator looked at your account is most of the point of
        // recording it (BRD §8.13).
        reason: entry.reason,
        // Already null on anything the reader did not do — the service
        // withholds the actor's address rather than this route remembering to.
        ipAddress: entry.ipAddress,
        // Same: null on anything the reader did not do, decided in the service.
        // Served raw rather than resolved to a device, because resolving it
        // would mean Audit reading Identity and closing a module cycle. The page
        // has both lists and matches them there (ADR 0025).
        sessionId: entry.sessionId,
        // ISO on the wire; the page renders it in the reader's locale. The
        // digests are absent because the service never returns them.
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }
}
