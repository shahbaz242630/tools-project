import { Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ME_DELETION_PATH } from '@platform/contracts';
import type { DeletionResponse } from '@platform/contracts';
import { AuthGuard, IDENTITY_SERVICE } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import type { IdentityService } from './identity.service.js';
import type { MirroredUser } from './user-directory.js';

/**
 * Deleting your own account.
 *
 * No id in the path, the same reasoning as every other `/me` route: the account
 * to delete is the one the session proves you hold. **That matters more here
 * than anywhere else** — a route that took an id would make "may this person
 * delete that account" a check somebody has to remember, and forgetting it once
 * is unrecoverable for whoever was deleted.
 *
 * `POST` rather than `DELETE`, because what happens is not a hard delete: the
 * personal data goes, the account row survives as a tombstone, and the audit
 * trail is retained. The verb should not promise more than the platform does.
 */
@Controller()
@UseGuards(AuthGuard)
export class MeDeletionController {
  constructor(@Inject(IDENTITY_SERVICE) private readonly identity: IdentityService) {}

  @Post(ME_DELETION_PATH)
  // 200 rather than 202: by the time this answers, the erasure has happened.
  // Accepted would suggest something is still queued, and there is nothing to
  // come back for.
  @HttpCode(200)
  async request(
    @CurrentUser() user: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<DeletionResponse> {
    await this.identity.requestDeletion({
      userId: user.id,
      ipAddress: request.clientIp ?? null,
    });

    return { outcome: 'deleted' };
  }
}
