import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ME_EXPORT_PATH } from '@platform/contracts';
import type { DataExport } from '@platform/contracts';
import { AllowsSuspended, AuthGuard, IDENTITY_SERVICE } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import type { IdentityService } from './identity.service.js';
import type { MirroredUser } from './user-directory.js';

/**
 * Everything the platform holds about you.
 *
 * No id in the path, and here that is doing more work than anywhere else: this
 * route returns a decrypted home address. A parameter would make "may this
 * person read that" a check somebody has to remember, on the one endpoint where
 * forgetting it discloses everything about somebody to a stranger.
 *
 * There is deliberately no administrative variant. Exporting somebody else's
 * data is a support capability and belongs with the admin role, its MFA
 * requirement and its own audit entries — not with a query parameter.
 */
@Controller()
@UseGuards(AuthGuard)
export class MeExportController {
  constructor(@Inject(IDENTITY_SERVICE) private readonly identity: IdentityService) {}

  @Get(ME_EXPORT_PATH)
  @AllowsSuspended()
  async export(
    @CurrentUser() user: MirroredUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<DataExport> {
    const document = await this.identity.exportFor({
      userId: user.id,
      ipAddress: request.clientIp ?? null,
      sessionId: request.sessionId ?? null,
    });

    // Unreachable in practice — the guard resolved this account a moment ago —
    // but returning an empty document would be worse than saying nothing was
    // found, and asserting non-null would turn a race into a 500.
    if (document === null) throw new NotFoundException();

    return document;
  }
}
