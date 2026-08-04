import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ME_PATH } from '@platform/contracts';
import type { MeResponse } from '@platform/contracts';
import { ADMIN_MFA_BYPASS, AllowsSuspended, AuthGuard } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { MirroredUser } from './user-directory.js';

/**
 * The signed-in account.
 *
 * Small, and load-bearing out of proportion to its size: it is the first route
 * in the codebase that answers differently depending on who is asking, and the
 * shape every later ownership check follows. There is deliberately no
 * `GET /users/:id` beside it. The moment an id appears in a path, "can this
 * person read that row" becomes a question someone has to remember to ask;
 * answering only for the caller's own account means it cannot be forgotten.
 */
@Controller()
@UseGuards(AuthGuard)
export class MeController {
  /**
   * The same value the guard was given, reported rather than re-derived.
   *
   * Injecting the token means the banner the web app renders and the check the
   * guard performs are the *same* boolean. Reading the environment again here
   * would be a second source that can disagree — and it would disagree exactly
   * when it matters, because the two would then be answering different
   * questions: what is configured, and what is being enforced.
   */
  constructor(@Inject(ADMIN_MFA_BYPASS) private readonly mfaBypassed: boolean) {}

  @Get(ME_PATH)
  @AllowsSuspended()
  me(@CurrentUser() user: MirroredUser): MeResponse {
    // Field by field rather than spreading the row. A mirrored record grows
    // columns — Clerk ids, deletion timestamps, a suspension reason — and a
    // spread would serialise each new one the day it was added.
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      // Only ever the caller's own, because this route answers for nobody else.
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
      suspensionReason: user.suspensionReason,
      adminMfaBypassed: this.mfaBypassed,
    };
  }
}
