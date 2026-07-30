import { Controller, Get, UseGuards } from '@nestjs/common';
import { ME_PATH } from '@platform/contracts';
import type { MeResponse } from '@platform/contracts';
import { AuthGuard } from './auth.guard.js';
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
  @Get(ME_PATH)
  me(@CurrentUser() user: MirroredUser): MeResponse {
    // Field by field rather than spreading the row. A mirrored record grows
    // columns — Clerk ids, deletion timestamps, later a suspension reason — and
    // a spread would serialise each new one the day it was added.
    return { id: user.id, email: user.email, role: user.role };
  }
}
