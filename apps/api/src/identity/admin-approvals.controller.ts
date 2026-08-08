import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_APPROVALS_PATH,
  ADMIN_APPROVE_ROUTE,
  ADMIN_CANCEL_ROUTE,
  ContractViolationError,
  isAccountId,
  parseApprovalDecision,
  parseRoleChangeProposal,
} from '@platform/contracts';
import type { AdminApprovalList, AdminApprovalView } from '@platform/contracts';
import { Time } from '@platform/core';
import { AuthGuard, Roles } from './auth.guard.js';
import { ROLE_APPROVAL_SERVICE } from './identity.tokens.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import { ApprovalConflictError, approvalState } from './admin-approval.js';
import type { AdminApproval } from './admin-approval.js';
import { ApprovalRefusedError } from './identity-errors.js';
import type { RoleApprovalService } from './role-approval.service.js';
import type { MirroredUser } from './user-directory.js';

/**
 * Dual approval — BRD §8.13's "for selected actions, dual approval".
 *
 * **The platform's first administrative write surface.** Everything an
 * administrator could do before this was a read. That is why it arrives behind
 * two people rather than after them: retrofitting approval onto an action
 * people already use is much harder than building the action inside it
 * (ADR 0022 said so; ADR 0023 is the result).
 *
 * Every route is `@Roles('ADMIN')`, so a recently verified second factor is
 * required of both administrators by the guard rather than by anything here.
 *
 * Three status codes, and the distinction is deliberate:
 *
 *   - **400** the request is malformed — a reason too short, a role that is not
 *     a role. Fix the request and try again.
 *   - **404** no such proposal, or an id that is not an id.
 *   - **409** the request is well formed but the world disagrees — you proposed
 *     this yourself, somebody already decided it, it expired, or it would leave
 *     the platform with no administrator. Nothing to fix in the request.
 */
@Controller()
@UseGuards(AuthGuard)
export class AdminApprovalsController {
  constructor(
    @Inject(ROLE_APPROVAL_SERVICE) private readonly identity: RoleApprovalService,
  ) {}

  @Get(ADMIN_APPROVALS_PATH)
  @Roles('ADMIN')
  async list(): Promise<AdminApprovalList> {
    const approvals = await this.identity.listPendingApprovals();
    return { approvals: approvals.map(toView) };
  }

  @Post(ADMIN_APPROVALS_PATH)
  @Roles('ADMIN')
  // 201: a proposal is a thing that now exists and can be fetched from the
  // queue. It is emphatically not the change itself — that needs somebody else.
  @HttpCode(201)
  async propose(
    @Body() body: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminApprovalView> {
    const proposal = this.parse(() => parseRoleChangeProposal(body));

    return this.translate(async () =>
      toView(
        await this.identity.proposeRoleChange(
          {
            userId: admin.id,
            ipAddress: request.clientIp ?? null,
            sessionId: request.sessionId ?? null,
          },
          proposal.userId,
          proposal.role,
          proposal.reason,
        ),
      ),
    );
  }

  @Post(ADMIN_APPROVE_ROUTE)
  @Roles('ADMIN')
  @HttpCode(200)
  async approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminApprovalView> {
    if (!isAccountId(id)) throw new NotFoundException();
    const { reason } = this.parse(() => parseApprovalDecision(body));

    return this.translate(async () =>
      toView(
        await this.identity.approve(
          {
            userId: admin.id,
            ipAddress: request.clientIp ?? null,
            sessionId: request.sessionId ?? null,
          },
          id,
          reason,
        ),
      ),
    );
  }

  @Post(ADMIN_CANCEL_ROUTE)
  @Roles('ADMIN')
  @HttpCode(200)
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() admin: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminApprovalView> {
    if (!isAccountId(id)) throw new NotFoundException();
    const { reason } = this.parse(() => parseApprovalDecision(body));

    return this.translate(async () =>
      toView(
        await this.identity.cancelApproval(
          {
            userId: admin.id,
            ipAddress: request.clientIp ?? null,
            sessionId: request.sessionId ?? null,
          },
          id,
          reason,
        ),
      ),
    );
  }

  private parse<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof ContractViolationError) {
        throw new BadRequestException({
          message: 'The request was rejected',
          issues: error.issues,
        });
      }
      throw error;
    }
  }

  /**
   * Turn the service's two refusal kinds into their status codes.
   *
   * Kept in one place rather than a try/catch per route, so a new route cannot
   * report the same refusal as a 500 by forgetting to translate it.
   */
  private async translate<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApprovalRefusedError) {
        // 409, not 400. The request is well formed; the state of the world is
        // what refuses it, and re-sending the same body may succeed later.
        throw new ConflictException({ message: error.message });
      }
      if (error instanceof ApprovalConflictError) {
        throw new ConflictException({ message: error.message });
      }
      throw error;
    }
  }
}

function toView(approval: AdminApproval): AdminApprovalView {
  return {
    id: approval.id,
    action: approval.action,
    targetId: approval.targetId,
    // Derived here rather than stored, so there is no status column to keep
    // true alongside the timestamps that already say everything.
    state: approvalState(approval, Time.nowUtc()),
    proposedById: approval.proposedById,
    proposedReason: approval.proposedReason,
    proposedAt: approval.proposedAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    approvedById: approval.approvedById,
    approvedReason: approval.approvedReason,
    approvedAt: approval.approvedAt?.toISOString() ?? null,
    cancelledById: approval.cancelledById,
    cancelledReason: approval.cancelledReason,
    cancelledAt: approval.cancelledAt?.toISOString() ?? null,
  };
}
