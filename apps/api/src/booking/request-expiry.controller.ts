import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { EXPIRE_REQUESTS_ROUTE } from '@platform/contracts';
import type { ExpirySweep } from '@platform/contracts';
import { REQUEST_EXPIRY_SERVICE } from './booking.tokens.js';
import { InternalTriggerGuard } from '../internal-trigger/internal-trigger.guard.js';
import type { RequestExpiryService } from './request-expiry.service.js';

/**
 * Where scheduled work is set off (slice 4.7a, ADR 0048).
 *
 * **`InternalTriggerGuard` rather than `AuthGuard`, and this is the only controller
 * in the API that does not use the latter.** There is no session here and nothing
 * to scope to — see the guard for why network position was refused as a substitute
 * for a credential, and `request-expiry.service.ts` for why the sweep cannot simply
 * live in the worker.
 *
 * **`POST` rather than `GET`, and not because of the verb's semantics.** It changes
 * state, so it could not be a `GET` anyway — but the reason worth writing down is
 * that a `GET` is the thing a crawler, a link checker, a browser prefetch or a
 * naive uptime monitor will call on its own. This endpoint must only ever run when
 * something meant it to.
 *
 * **It is deliberately not idempotency-keyed**, unlike the payment operations
 * CLAUDE.md requires keys for. The work itself is idempotent — the state predicate
 * is inside the `UPDATE` — so a re-delivered job expires nothing twice, and a key
 * would be ceremony protecting an operation that needs no protecting.
 *
 * **No `@AllowsSuspended`, no roles, no `@CurrentUser`.** None of those concepts
 * exist on this path; a decorator from the session world appearing here would
 * suggest they did.
 */
@Controller()
@UseGuards(InternalTriggerGuard)
export class RequestExpiryController {
  constructor(
    @Inject(REQUEST_EXPIRY_SERVICE) private readonly expiry: RequestExpiryService,
  ) {}

  /**
   * Expire every request past its §8.6 deadline.
   *
   * **200 with a count, even when nothing expired**, and no other outcome exists.
   * A sweep that found nothing to do has succeeded — the overwhelmingly common
   * case, and answering 404 or 204 for it would make "nothing was overdue"
   * indistinguishable from "the route is gone" in a worker's logs. There is no
   * refusal to model: the sweep takes no input a caller could get wrong.
   *
   * A failure here is an unhandled throw and therefore a 500, which is correct: the
   * queue owns retrying, and a sweep that could not reach the database has nothing
   * useful to say about it.
   */
  @Post(EXPIRE_REQUESTS_ROUTE)
  /*
   * **200, not Nest's default 201 for a POST.** Nothing is created here — the sweep
   * changes rows that already existed — and a `201` would invite a caller to look
   * for a `Location` header for a resource that does not exist.
   */
  @HttpCode(200)
  async expireRequests(): Promise<ExpirySweep> {
    const { expired, reachedLimit } = await this.expiry.sweep();

    return {
      expired: expired.length,
      /*
       * Ids only. The renter and listing ids the store returns stop here — they
       * exist so a later notification path (Phase 6) can find who to tell, and an
       * unscoped caller has no business holding them. `expirySweepSchema` is
       * `strictObject`, so adding them later is a deliberate act rather than a
       * field that leaks in behind a spread.
       */
      bookingIds: expired.map((request) => request.id),
      reachedLimit,
    };
  }
}
