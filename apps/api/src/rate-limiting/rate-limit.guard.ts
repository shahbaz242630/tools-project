import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Logger, Metrics } from '@platform/observability';
import { accountRateLimitKey } from './rate-limiter.js';
import type { RateLimitPolicy, RateLimitTier, RateLimiter } from './rate-limiter.js';

export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const RATE_LIMIT_POLICIES = Symbol('RATE_LIMIT_POLICIES');
export const RATE_LIMIT_LOGGER = Symbol('RATE_LIMIT_LOGGER');
export const RATE_LIMIT_METRICS = Symbol('RATE_LIMIT_METRICS');

const RATE_LIMIT_TIER = Symbol('RATE_LIMIT_TIER');

/**
 * What this route costs us, and therefore which allowance it spends.
 *
 * **Explicit per route rather than inferred from the HTTP method.** `GET` and
 * `POST` are a poor proxy for cost — a search is a `GET` and is the most
 * expensive thing here — and an inference nobody wrote down is one nobody
 * revisits when a route changes shape.
 */
export const RateLimit = (tier: RateLimitTier): MethodDecorator =>
  SetMetadata(RATE_LIMIT_TIER, tier);

interface LimitedRequest {
  user?: { id: string };
}

/**
 * BRD §10's per-account limit — slice H7a.
 *
 * ## Where this sits, and what it cannot do
 *
 * **After `AuthGuard`, because it keys on the account `AuthGuard` produces.** The
 * consequence is worth stating plainly rather than discovering: **an
 * unauthenticated flood is not touched by this guard at all**, and neither is a
 * flood against a public route, because no account is attached to either. That
 * is slice H7b's work, and it carries the decision this one does not have to
 * take — the API cannot see a caller's IP on public reads today, because
 * `apps/web` deliberately does not forward `x-client-ip` for a read that records
 * nothing (ADR 0017).
 *
 * So this closes the *authenticated* half of §2.1, which is the half where a
 * caller is somebody we can name and suspend. It is not the whole gap and the
 * handoff should not say it is.
 *
 * ## Failing open is a decision, and it is recorded on the policy
 *
 * `SECURITY.md` §4: *"Fail open or closed, deliberately and per route… because
 * the default will otherwise be whichever the library chose."* Every tier here
 * is `allow`, argued in `policy.ts`. This guard **never decides that for
 * itself** — it reads `onStoreFailure` — which is what keeps the answer in one
 * reviewable place instead of in a `catch` block.
 *
 * ## What it records, and what it must never record
 *
 * A refusal is a counter, not an audit entry. `SECURITY.md` §4 requires an
 * automated *ban* to be attributable and reversible; a throttle that clears in
 * sixty seconds is neither a ban nor something a human should be paged about,
 * and one audit row per refused request would flood the trail that exists to be
 * read during an incident.
 *
 * **The account id never becomes a metric label.** It is in the Redis key, which
 * expires with the window and is exported nowhere; a label is held in process
 * memory and scraped into a system with none of §10.1's retention or erasure
 * rules. CLAUDE.md: cardinality is a retention and personal-data decision, not a
 * formatting one.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(RATE_LIMIT_POLICIES)
    private readonly policies: Readonly<Record<RateLimitTier, RateLimitPolicy>>,
    @Inject(RATE_LIMIT_LOGGER) private readonly logger: Logger,
    @Inject(RATE_LIMIT_METRICS) private readonly metrics: Metrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tier = this.reflector.getAllAndOverride<RateLimitTier | undefined>(
      RATE_LIMIT_TIER,
      [context.getHandler(), context.getClass()],
    );

    // An undecorated route is not limited. Deliberately permissive: this guard
    // is applied per controller like `AuthGuard`, and a route that opted into
    // neither should behave as it did before this slice rather than fail.
    if (tier === undefined) return true;

    const request = context.switchToHttp().getRequest<LimitedRequest>();
    const accountId = request.user?.id;

    /*
     * **No account means this guard has nothing to key on, and it says so rather
     * than inventing one.** Reaching here without a user means the route is not
     * behind `AuthGuard`, or this guard was ordered before it — both of which are
     * wiring mistakes rather than caller behaviour. Falling back to a shared key
     * would put every anonymous caller in one bucket and take the route down for
     * all of them the first time one of them was busy.
     */
    if (accountId === undefined) {
      this.logger.warn('rate limit skipped: no account on the request', { tier });
      return true;
    }

    const policy = this.policies[tier];
    const key = accountRateLimitKey(tier, accountId);

    let decision;
    try {
      decision = await this.limiter.consume(key, policy);
    } catch (error) {
      this.metrics.recordRateLimit({ tier, outcome: 'unavailable' });
      this.logger.warn('rate limit counter unavailable', {
        error,
        tier,
        onStoreFailure: policy.onStoreFailure,
      });

      if (policy.onStoreFailure === 'allow') return true;
      throw new HttpException(
        'This is temporarily unavailable. Please try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (decision.allowed) {
      this.metrics.recordRateLimit({ tier, outcome: 'allowed' });
      return true;
    }

    this.metrics.recordRateLimit({ tier, outcome: 'refused' });
    /*
     * **Logged at `warn` with the account id, which the metric deliberately does
     * not carry.** A log line is retained under §10.1's schedule and can be
     * erased with the account; a metric series cannot. Somebody diagnosing "why
     * was I refused" needs the id, and this is the place it may live.
     */
    this.logger.warn('rate limit refused a request', {
      tier,
      accountId,
      limit: decision.limit,
      resetInSeconds: decision.resetInSeconds,
    });

    /*
     * **`Retry-After`, set on the reply rather than described in the body.** It
     * is the one part of a 429 a client can act on without parsing prose, and a
     * limiter that refuses without it makes every caller guess — which produces
     * exactly the retry storm the limit exists to prevent. In whole seconds,
     * which is the form the spec defines.
     */
    context
      .switchToHttp()
      .getResponse<{ header(name: string, value: string): unknown }>()
      .header('Retry-After', String(retryAfterSeconds(decision.resetInSeconds)));

    /*
     * **A sentence, not a bare status.** The Phase 0–3 audit's standing finding
     * is that a green suite cannot see a false sentence, and a 429 is read by a
     * person far more often than by a client. It says what happened, that it is
     * temporary, and that waiting fixes it — **without naming the limit**, which
     * would tell somebody probing exactly what budget they are working against.
     */
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message:
          'You have made a lot of requests in a short time. Please wait a moment and try again.',
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * The `Retry-After` value for a refusal, in whole seconds and never below one.
 *
 * **Never zero.** A `Retry-After: 0` invites an immediate retry, which is
 * refused, which returns another zero — a client honouring the header politely
 * becomes the flood. Rounded up rather than down for the same reason.
 */
export function retryAfterSeconds(resetInSeconds: number): number {
  return Math.max(1, Math.ceil(resetInSeconds));
}
