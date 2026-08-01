import { Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isIP } from 'node:net';
import { CLIENT_IP_HEADER } from '@platform/contracts';
import type { Logger } from '@platform/observability';
import { AccountDeletedError } from './identity.service.js';
import type { IdentityService } from './identity.service.js';
import { SessionVerificationError } from './session-verifier.js';
import type { SessionVerifier, VerifiedSession } from './session-verifier.js';
import type { MirroredUser, UserRole } from './user-directory.js';

export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');
export const IDENTITY_SERVICE = Symbol('IDENTITY_SERVICE');
export const AUTH_LOGGER = Symbol('AUTH_LOGGER');

const REQUIRED_ROLES = Symbol('REQUIRED_ROLES');
const ALLOWS_SUSPENDED = Symbol('ALLOWS_SUSPENDED');

/**
 * How recently an administrator's second factor must have been verified.
 *
 * An engineering bound on how long a privileged session stays privileged, not a
 * business rule — BRD §8.13 asks for step-up authentication on high-risk
 * actions without naming a number. Twelve hours keeps a support shift working
 * without leaving a forgotten browser tab administratively capable overnight.
 */
export const MAX_SECOND_FACTOR_AGE_MINUTES = 12 * 60;

/**
 * Restrict a route to the listed roles.
 *
 * Absence means "any authenticated user", never "anyone" — the guard is applied
 * to the controller, so a route with no decorator is still authenticated. That
 * default is the safe one: forgetting a decorator loses a restriction, whereas
 * an opt-in scheme would forget authentication itself.
 */
export const Roles = (...roles: readonly UserRole[]): MethodDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

/**
 * Let a suspended account reach this route.
 *
 * **Default-deny**, the opposite of `@Roles`. A suspended account is refused
 * everything unless a route says otherwise, so a route added later is closed to
 * suspended users by forgetting nothing — the failure mode of an opt-out scheme
 * is a suspended person still able to act, which is the whole thing suspension
 * exists to prevent.
 *
 * What carries this decorator is therefore a short and deliberate list: reading
 * your own account, your own profile, your own activity, exporting your data
 * and deleting it. **UK GDPR access and erasure rights do not lapse because
 * somebody was suspended**, and an account that cannot authenticate cannot
 * exercise them (ADR 0024). Everything else — anything that acts on the
 * platform or changes anything — stays refused.
 */
export const AllowsSuspended = (): MethodDecorator =>
  SetMetadata(ALLOWS_SUSPENDED, true);

/** The request, once the guard has resolved who is making it. */
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: MirroredUser;
  sessionId?: string;

  /** Minutes since the second factor was verified, or null if it never was. */
  secondFactorAgeMinutes?: number | null;

  /**
   * The client's address as the web app reported it, or null.
   *
   * Resolved once by the guard and attached, rather than each controller
   * reaching for the header itself — one place to change if the trust model
   * ever does, and one place a reviewer has to look to see what it rests on.
   */
  clientIp?: string | null;
}

/**
 * The client's address, from the header the web app sets.
 *
 * Validated with `isIP` rather than merely trimmed, and that is not belt and
 * braces — it is load-bearing. The address lands in an `inet` column, so a
 * malformed value makes the insert throw; the audit write is deliberately
 * fail-closed, so that throw would take down the request it was auditing.
 * A header nobody validated could therefore turn every authenticated request
 * into a 500. Recording null is the honest answer to "we cannot tell", and it
 * keeps a bad header from becoming an outage.
 *
 * **Fastify joins a repeated header into one comma-separated string**, so
 * `x-client-ip: a` sent twice arrives as `"a,b"` — a string, not an array, and
 * therefore past any `typeof` check. `isIP` rejects it, which is the point:
 * two values means something sits between us and the web app, and picking one
 * would record a guess as fact.
 *
 * The value is trusted because the API is unreachable from the internet, not
 * because the header is authoritative — see ADR 0017.
 */
export function clientIpFrom(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[CLIENT_IP_HEADER];
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return isIP(trimmed) === 0 ? null : trimmed;
}

/**
 * Extract a bearer token.
 *
 * Case-insensitive on the scheme, because the standard says so and a client
 * sending `bearer` is not an attacker. Rejects a header with anything other
 * than exactly two parts rather than trying to be helpful about it.
 */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;

  const parts = header.split(' ').filter((part) => part !== '');
  if (parts.length !== 2) return null;
  if (parts[0]?.toLowerCase() !== 'bearer') return null;

  return parts[1] ?? null;
}

/**
 * Authenticates every request on the controllers it guards.
 *
 * The API is not reachable from the internet — only the web app is on the edge
 * network, and CI asserts it. That is emphatically **not** why this exists: an
 * internal-only service still needs to know which user a request speaks for,
 * and BRD §14 Phase 1 requires the check to be server-side rather than
 * inferred from anything the caller says about itself. The web app forwards a
 * Clerk-signed token; this verifies it. It never trusts a header naming a user.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
    @Inject(IDENTITY_SERVICE) private readonly identity: IdentityService,
    @Inject(AUTH_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = bearerToken(request.headers['authorization']);
    if (token === null) {
      throw new UnauthorizedException();
    }

    const session = await this.verify(token);
    const clientIp = clientIpFrom(request.headers);

    const user = await this.resolve(session.clerkUserId, () =>
      this.identity.resolveSession(session, clientIp),
    );

    request.user = user;
    request.sessionId = session.sessionId;
    request.clientIp = clientIp;
    request.secondFactorAgeMinutes = session.secondFactorAgeMinutes;

    this.authorise(context, user, session);

    return true;
  }

  private async verify(token: string): ReturnType<SessionVerifier['verify']> {
    try {
      return await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof SessionVerificationError) {
        // Logged with the cause, answered without it. Which check failed is a
        // hint to whoever is probing the endpoint; the log is where it belongs.
        this.logger.warn('rejected session token', { error: error.cause });
        throw new UnauthorizedException();
      }
      throw error;
    }
  }

  private async resolve(
    clerkUserId: string,
    resolve: () => Promise<MirroredUser>,
  ): Promise<MirroredUser> {
    try {
      return await resolve();
    } catch (error) {
      if (error instanceof AccountDeletedError) {
        this.logger.warn('rejected session for a deleted account', { clerkUserId });
        throw new UnauthorizedException();
      }
      throw error;
    }
  }

  private authorise(
    context: ExecutionContext,
    user: MirroredUser,
    session: VerifiedSession,
  ): void {
    this.refuseIfSuspended(context, user);

    const required = this.reflector.getAllAndOverride<readonly UserRole[] | undefined>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );

    if (required === undefined || required.length === 0) return;

    if (!required.includes(user.role)) {
      // 403, not 404. Hiding the route's existence from an authenticated user
      // who simply lacks the role buys nothing — they already know the URL —
      // and it makes a genuine permissions bug indistinguishable from a typo.
      this.logger.warn('rejected request lacking a required role', {
        userId: user.id,
        role: user.role,
        required,
      });
      throw new ForbiddenException();
    }

    // MFA is enforced here rather than by a decorator per route, because BRD
    // §8.1 requires it *of administrators* rather than of particular actions.
    // Folding it into the role check means an admin route cannot be added
    // without it by forgetting something — the same reasoning that makes an
    // absent `@Roles` mean "authenticated" rather than "anyone".
    if (required.includes('ADMIN')) {
      this.requireSecondFactor(user, session);
    }
  }

  /**
   * Refuse a suspended account, unless the route opted in.
   *
   * **403, not 401.** The session is perfectly valid and signing in again will
   * not help — answering 401 would send somebody round a loop of re-signing-in
   * that cannot end, which is exactly what a deleted account *does* get,
   * because there the session genuinely is dead.
   *
   * A suspended administrator is refused every admin route by this, since none
   * of them opt in. That is deliberate: the role is not what makes somebody
   * able to act, and an administrator under investigation should not be able to
   * lift their own suspension.
   */
  private refuseIfSuspended(context: ExecutionContext, user: MirroredUser): void {
    if (user.suspendedAt === null) return;

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOWS_SUSPENDED,
      [context.getHandler(), context.getClass()],
    );
    if (allowed === true) return;

    this.logger.warn('rejected request from a suspended account', {
      userId: user.id,
      // Not the reason — it is the person's, and a log line is not where it
      // belongs. The audit trail and their own account page both carry it.
      suspendedAt: user.suspendedAt.toISOString(),
    });
    throw new ForbiddenException();
  }

  /**
   * Refuse unless the session proves a recent second factor.
   *
   * **Null fails.** It means the token carried no factor-verification claim,
   * which happens when the Clerk instance was not provisioned with one — and
   * the only safe reading of "we cannot tell" is "not verified". Treating it as
   * satisfied would turn a missing piece of instance configuration into an open
   * admin surface, silently, on a correctly-signed token (ADR 0021).
   */
  private requireSecondFactor(user: MirroredUser, session: VerifiedSession): void {
    const age = session.secondFactorAgeMinutes;

    if (age === null || age > MAX_SECOND_FACTOR_AGE_MINUTES) {
      this.logger.warn('rejected admin request without a recent second factor', {
        userId: user.id,
        // The age, not the reason for the decision — an administrator debugging
        // their own lockout needs to see whether the claim was absent or stale.
        secondFactorAgeMinutes: age,
        maximumMinutes: MAX_SECOND_FACTOR_AGE_MINUTES,
      });
      throw new ForbiddenException();
    }
  }
}
