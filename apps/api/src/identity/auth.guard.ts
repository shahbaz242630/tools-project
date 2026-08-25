import { Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CLIENT_IP_HEADER } from '@platform/contracts';
import type { Logger } from '@platform/observability';
import { AccountDeletedError } from './identity-errors.js';
import { validIpOrNull } from './ip-address.js';
import type { IdentityService } from './identity.service.js';
import type { SecondFactorEvidence } from './admin-second-factor.js';
import type { SecondFactorChain } from './second-factor-chain.js';
import { SessionVerificationError } from './session-verifier.js';
import type { SessionVerifier } from './session-verifier.js';
import type { MirroredUser, UserRole } from './user-directory.js';

export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');
/**
 * The mirror service — what the guard resolves a session against.
 *
 * Still named `IDENTITY_SERVICE` after slice H4 split the class four ways,
 * because this is the piece the guard was always reaching for. The three
 * services that moved out have their own tokens in `identity.tokens.ts`; they
 * are not here because nothing in the guard injects them, and a token declared
 * beside a guard that does not use it is a hint in the wrong direction.
 */
export const IDENTITY_SERVICE = Symbol('IDENTITY_SERVICE');
export const AUTH_LOGGER = Symbol('AUTH_LOGGER');

/**
 * Whether any installed prover admits an administrator with no second factor.
 *
 * **Reported by `/me` so the admin layout can carry ADR 0030's banner, and read
 * by nothing else.** It is no longer a flag the guard consults: from slice H8a
 * the guard has no bypass branch at all and asks {@link ADMIN_SECOND_FACTOR}
 * instead. `app.module.ts` derives this boolean *from the chain*, so what a
 * page says and what the guard enforces cannot disagree — which is the property
 * ADR 0030 was protecting when it refused to let the web app hold a flag of its
 * own.
 */
export const ADMIN_MFA_BYPASS = Symbol('ADMIN_MFA_BYPASS');

/**
 * The chain of things that can prove an administrator's second factor.
 *
 * See `admin-second-factor.ts` for the port and `second-factor-chain.ts` for the
 * order it asks in, which is load-bearing.
 */
export const ADMIN_SECOND_FACTOR = Symbol('ADMIN_SECOND_FACTOR');

const REQUIRED_ROLES = Symbol('REQUIRED_ROLES');
const ALLOWS_SUSPENDED = Symbol('ALLOWS_SUSPENDED');

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
  // The validation itself lives in `ip-address.ts`, shared with the
  // authentication event store. Two copies of this rule would drift on exactly
  // the case that matters — see the note there.
  return validIpOrNull(headers[CLIENT_IP_HEADER]);
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
    @Inject(ADMIN_SECOND_FACTOR) private readonly secondFactor: SecondFactorChain,
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
    // `secondFactorAgeMinutes` was attached here until slice H8a and is not
    // any more. It meant "what Clerk said", which stopped being the same thing
    // as "whether a second factor was proven" the moment a second prover
    // existed — an admitted request can now carry a null Clerk age. Nothing
    // read it, so it went rather than acquiring a caveat nobody would reread.

    // The headers travel with the session because one prover reads an assertion
    // out of them (Cloudflare Access, slice H8b) while another reads the
    // session. Assembled here rather than inside the guard's private methods so
    // there is one place a reviewer can see everything a second factor may rest
    // on.
    await this.authorise(context, user, { session, headers: request.headers });

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

  private async authorise(
    context: ExecutionContext,
    user: MirroredUser,
    evidence: SecondFactorEvidence,
  ): Promise<void> {
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
      await this.requireSecondFactor(user, evidence);
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
   * Refuse unless something proves a recent second factor.
   *
   * **There is no bypass in here, and that is the point of slice H8a.** The
   * guard asks the chain and refuses when the answer is null; whether an
   * exception is installed is a fact about how `main.ts` composed the chain,
   * not a branch in the one method that must never be able to say "no
   * credential needed". `DevelopmentSecondFactor` is the exception now, it is
   * asked last, and it cannot be constructed in production at all.
   *
   * **Null still fails, for the same reason it always did.** No prover could
   * tell — an absent claim, an absent assertion, a provider that did not
   * answer — and the only safe reading of "we cannot tell" is "not verified".
   * Treating it as satisfied would turn a missing piece of provider
   * configuration into an open admin surface, silently, on a correctly-signed
   * token (ADR 0021).
   */
  private async requireSecondFactor(
    user: MirroredUser,
    evidence: SecondFactorEvidence,
  ): Promise<void> {
    const decision = await this.secondFactor.prove(evidence);

    if (decision.proof === null) {
      this.logger.warn('rejected admin request without a recent second factor', {
        userId: user.id,
        // Every prover that answered, with its age — not the reason for the
        // decision. An administrator debugging their own lockout needs to see
        // whether a claim was *absent* or merely *stale*, and which provider
        // said so; a bare 403 sends them looking at the wrong thing.
        attempts: decision.attempts,
        // The chain's own bound, not the module constant. They are the same
        // today; a line that says otherwise the first time one is overridden
        // is a false sentence waiting to be written.
        maximumMinutes: this.secondFactor.maximumAge,
      });
      throw new ForbiddenException();
    }
  }
}
