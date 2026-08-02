import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ME_SIGN_INS_PATH } from '@platform/contracts';
import type { SignInsResponse } from '@platform/contracts';
import { AllowsSuspended, AuthGuard, IDENTITY_SERVICE } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { IdentityService } from './identity.service.js';
import type { MirroredUser } from './user-directory.js';

/**
 * The caller's own sign-in history — BRD §8.1's authentication events.
 *
 * No id in the path, the same rule `/me/activity` and `/me/profile` follow: the
 * account comes from the verified session, so there is no way to address
 * anybody else's. That matters more here than usual, because a sign-in list is
 * a map of where somebody has been.
 *
 * **There is deliberately no administrative equivalent.** ADR 0022 made the
 * admin account view the narrowest projection that helps support — no street
 * lines, no phone number — and a person's address and location history is
 * emphatically not in that category. If support ever genuinely needs it, that
 * is its own slice with its own reason field and its own audit entry, not a
 * query parameter added here.
 */
@Controller()
@UseGuards(AuthGuard)
export class MeSignInsController {
  constructor(@Inject(IDENTITY_SERVICE) private readonly identity: IdentityService) {}

  /**
   * Survives suspension, and it matters most then.
   *
   * A suspended person keeps the right to read what we hold about them
   * (ADR 0024), and somebody suspended after an account takeover needs this
   * page precisely when they are least able to act on anything else.
   */
  @Get(ME_SIGN_INS_PATH)
  @AllowsSuspended()
  async list(@CurrentUser() user: MirroredUser): Promise<SignInsResponse> {
    const entries = await this.identity.signInsFor(user.id);

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        event: entry.event,
        sessionId: entry.clerkSessionId,
        // ISO on the wire; the page renders it in the reader's locale.
        occurredAt: entry.occurredAt.toISOString(),
        ipAddress: entry.activity.ipAddress,
        city: entry.activity.city,
        country: entry.activity.country,
        browserName: entry.activity.browserName,
        browserVersion: entry.activity.browserVersion,
        deviceType: entry.activity.deviceType,
        isMobile: entry.activity.isMobile,
      })),
    };
  }
}
