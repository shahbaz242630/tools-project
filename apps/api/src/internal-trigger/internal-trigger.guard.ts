import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Logger } from '@platform/observability';

export const INTERNAL_TRIGGER_SECRET = Symbol('INTERNAL_TRIGGER_SECRET');
export const INTERNAL_TRIGGER_LOGGER = Symbol('INTERNAL_TRIGGER_LOGGER');

/**
 * The header a scheduled trigger presents (slice 4.7a).
 *
 * **Not `Authorization: Bearer`, deliberately.** That header is `AuthGuard`'s, and
 * it means "a Clerk session token" everywhere else in this API. A machine secret
 * arriving in the same field would be a second meaning for one header — so the
 * first thing anyone debugging a 401 has to establish is which kind of credential
 * was expected, and the tempting fix is a guard that tries both.
 */
export const INTERNAL_TRIGGER_HEADER = 'x-internal-trigger';

/**
 * Who may set off scheduled work (slice 4.7a, ADR 0048).
 *
 * ## What this protects and what it is not
 *
 * The expiry sweep has no user. It is the platform acting on its own deadline, so
 * there is no session to verify and nobody to scope to — which means the route
 * behind this guard is **the only mutating endpoint in the API that is not reached
 * by a person**. That is exactly why it gets its own guard rather than an exemption
 * inside `AuthGuard`: an exemption is a branch in the one place that must never
 * have a way to say "no credential needed".
 *
 * **This is not authorisation and it carries no identity.** It answers one
 * question — did this come from something holding our shared secret — and nothing
 * downstream may infer a user, a role or a permission from it. There is no actor,
 * and the events the sweep writes say so with `actorId: null`.
 *
 * ## Why a shared secret, and what was rejected
 *
 * The sweep must run inside the API, because the booking module's rules and its
 * `booking_events` writes live there and `apps/worker` has no database client and
 * cannot import them (it is ESM, the API is CommonJS — ADR 0011). The schedule
 * belongs in the worker, because that is where BullMQ is. So something has to cross
 * from one process to the other, and it needs to prove it is us.
 *
 * **Network position was considered and refused as a control.** The API joins no
 * edge network and CI asserts it is unreachable from the internet, so in practice
 * only `web` and `worker` can dial it. Trusting that would mean an unauthenticated
 * mutating route whose only protection is topology — and one compromised container
 * then reaches it. It is the same reasoning §10.2 applies to an edge allowlist:
 * proving where traffic came from is not proving it was sent for us.
 *
 * ## The comparison, and why it is not `===`
 *
 * `timingSafeEqual`, because a plain string comparison returns as soon as two bytes
 * differ, and the time it took is a measurement of how much of the prefix was
 * right. Against something that can call an internal endpoint in a tight loop, that
 * recovers the secret a byte at a time. **Lengths are compared first and separately
 * on purpose**: `timingSafeEqual` throws on a length mismatch rather than returning
 * false, and the length of a secret is not worth protecting.
 */
@Injectable()
export class InternalTriggerGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(
    @Inject(INTERNAL_TRIGGER_SECRET) secret: string,
    @Inject(INTERNAL_TRIGGER_LOGGER) private readonly logger: Logger,
  ) {
    /*
     * Encoded once at construction rather than per request. The environment
     * schema has already refused an absent or short secret, so there is no
     * "unconfigured" state for this guard to have an opinion about — which is the
     * whole point of it being required there rather than optional here.
     */
    this.expected = Buffer.from(secret, 'utf8');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    }>();

    const presented = request.headers[INTERNAL_TRIGGER_HEADER];

    /*
     * **`undefined` is the only case this narrowing really catches, and that was
     * established by walking it rather than assumed.** Node's type for a header is
     * `string | string[] | undefined`, so an array has to be excluded before
     * `Buffer.from` — but for an unknown custom header Node *joins* duplicates into
     * one comma-separated string rather than producing an array. Sending the
     * **correct** secret twice against the running API logged `mismatch`, not a
     * separate refusal: the joined value simply fails the comparison below, which is
     * the right answer anyway.
     *
     * So there is deliberately no `malformed` reason. An earlier version had one and
     * it was a vocabulary entry for a case nothing can reach — which is worse than
     * no entry, because it reads as a thing somebody has seen.
     */
    if (typeof presented !== 'string') this.refuse('absent');

    const offered = Buffer.from(presented, 'utf8');

    if (
      offered.length !== this.expected.length ||
      !timingSafeEqual(offered, this.expected)
    ) {
      this.refuse('mismatch');
    }

    return true;
  }

  /**
   * Refuse, and say only which of the two shapes it was.
   *
   * **The presented value is never logged, not even truncated.** A near-miss is
   * the most interesting thing an attacker could ask us to write down for them,
   * and a log line is a place with none of §10.1's guarantees. The reason is a
   * closed set of two words for the same argument that keeps a search term out of a
   * metric label.
   *
   * `warn` rather than `info`: nothing we run should ever produce one of these, so
   * every occurrence is either a misconfiguration or somebody knocking. It is also
   * the only signal that exists here — there are no alert rules yet, and this line
   * is what a future one would fire on.
   */
  private refuse(reason: 'absent' | 'mismatch'): never {
    this.logger.warn('refused an internal trigger', { reason });

    /*
     * 401 rather than 403, and identical for both reasons. The caller either
     * holds the secret or does not; telling it apart tells a prober whether the
     * header name was right, which is the one fact it does not already have.
     */
    throw new UnauthorizedException();
  }
}
