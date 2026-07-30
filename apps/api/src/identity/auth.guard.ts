import { Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Logger } from '@platform/observability';
import { AccountDeletedError } from './identity.service.js';
import type { IdentityService } from './identity.service.js';
import { SessionVerificationError } from './session-verifier.js';
import type { SessionVerifier } from './session-verifier.js';
import type { MirroredUser, UserRole } from './user-directory.js';

export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');
export const IDENTITY_SERVICE = Symbol('IDENTITY_SERVICE');
export const AUTH_LOGGER = Symbol('AUTH_LOGGER');

const REQUIRED_ROLES = Symbol('REQUIRED_ROLES');

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

/** The request, once the guard has resolved who is making it. */
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: MirroredUser;
  sessionId?: string;
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
    const user = await this.resolve(session.clerkUserId, () =>
      this.identity.resolveSession(session),
    );

    request.user = user;
    request.sessionId = session.sessionId;

    this.authorise(context, user);

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

  private authorise(context: ExecutionContext, user: MirroredUser): void {
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
  }
}
