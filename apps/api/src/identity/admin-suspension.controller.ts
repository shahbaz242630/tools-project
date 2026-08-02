import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_REINSTATE_ROUTE,
  ADMIN_SUSPEND_ROUTE,
  ContractViolationError,
  isAccountId,
  parseSuspensionDecision,
} from '@platform/contracts';
import type { AdminAccount } from '@platform/contracts';
import { Time } from '@platform/core';
import type { Actor } from '../audit/audit-log.js';
import { AuthGuard, IDENTITY_SERVICE, Roles } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import { ApprovalRefusedError } from './identity.service.js';
import type { IdentityService } from './identity.service.js';
import type { MirroredUser } from './user-directory.js';

/**
 * Suspending an account, and lifting a suspension.
 *
 * **One administrator, and deliberately not behind the dual approval a role
 * change needs** (ADR 0024). The asymmetry is the argument: a role change is
 * never urgent and its damage is done before anybody notices, while suspension
 * exists to stop harm quickly and undoes completely. A control that cannot act
 * quickly is not a safety control, and requiring two administrators would leave
 * this one unusable until two exist.
 *
 * What stands in for the second pair of eyes is the same thing that governs
 * every other admin action here: a mandatory reason, an audit entry, and the
 * fact that **the person it happened to reads both** — on their own activity
 * page and on their account page.
 *
 * The route is `@Roles('ADMIN')`, so a recently verified second factor is
 * required by the guard rather than by anything written here. It is also the
 * reason a suspended administrator cannot reach it: no admin route opts in to
 * `@AllowsSuspended`, so somebody under investigation cannot lift their own.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminSuspensionController {
  constructor(@Inject(IDENTITY_SERVICE) private readonly identity: IdentityService) {}

  @Post(ADMIN_SUSPEND_ROUTE)
  @Roles('ADMIN')
  @HttpCode(200)
  async suspend(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminAccount> {
    return this.decide(userId, body, admin, request, (actor, id, reason) =>
      this.identity.suspend(actor, id, reason),
    );
  }

  @Post(ADMIN_REINSTATE_ROUTE)
  @Roles('ADMIN')
  @HttpCode(200)
  async reinstate(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminAccount> {
    return this.decide(userId, body, admin, request, (actor, id, reason) =>
      this.identity.reinstate(actor, id, reason),
    );
  }

  /**
   * The shape both directions share.
   *
   * One place for the validation and the error translation, so a route cannot
   * report a refusal as a 500 by forgetting to handle it — and so suspending
   * and reinstating cannot drift into demanding different things.
   */
  private async decide(
    userId: string,
    body: unknown,
    admin: MirroredUser,
    request: AuthenticatedRequest,
    // `Actor` itself, not a structural copy of it. The copy that used to be
    // here silently stopped matching the moment the type gained a field, and a
    // hand-written duplicate of a security type is one that drifts on exactly
    // the field somebody added for a reason.
    act: (actor: Actor, id: string, reason: string) => Promise<MirroredUser>,
  ): Promise<AdminAccount> {
    // Before anything is written. `audit_logs.targetId` is a `uuid` column and
    // the entry is written inside the service, so an unvalidated path parameter
    // would throw on the insert — and a fail-closed audit write turns that into
    // a 500 on the action it was meant to record.
    if (!isAccountId(userId)) throw new NotFoundException();

    let reason: string;
    try {
      reason = parseSuspensionDecision(body).reason;
    } catch (error) {
      if (error instanceof ContractViolationError) {
        throw new BadRequestException({
          message: 'A reason is required, and the account holder will read it',
          issues: error.issues,
        });
      }
      throw error;
    }

    try {
      const user = await act(
        {
          userId: admin.id,
          ipAddress: request.clientIp ?? null,
          sessionId: request.sessionId ?? null,
        },
        userId,
        reason,
      );
      return toAccount(user);
    } catch (error) {
      if (error instanceof ApprovalRefusedError) {
        // 409, not 400. The request is well formed; the state of the world is
        // what refuses it — already suspended, the last administrator, or
        // yourself — and none of that is fixed by editing the body.
        throw new ConflictException({ message: error.message });
      }
      throw error;
    }
  }
}

function toAccount(user: MirroredUser): AdminAccount {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: Time.toIsoUtc(user.createdAt),
    deletedAt: user.deletedAt === null ? null : Time.toIsoUtc(user.deletedAt),
    deletionRequestedAt:
      user.deletionRequestedAt === null
        ? null
        : Time.toIsoUtc(user.deletionRequestedAt),
    suspendedAt: user.suspendedAt === null ? null : Time.toIsoUtc(user.suspendedAt),
    suspensionReason: user.suspensionReason,
  };
}
