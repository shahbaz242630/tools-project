import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRecordingLogger } from '@platform/observability/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard, Roles, bearerToken } from './auth.guard.js';
import { currentUserFrom } from './current-user.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import { IdentityService } from './identity.service.js';
import { InMemoryUserDirectory, InMemoryWebhookLedger } from './testing/fakes.js';
import { FakeSessionVerifier } from './testing/fakes.js';
import type { MirroredUser, UserRole } from './user-directory.js';

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
  });

  it.each([['bearer'], ['BEARER'], ['BeArEr']])(
    'accepts the %s scheme case-insensitively',
    (scheme) => {
      // RFC 7235 says the scheme is case-insensitive. A client sending
      // lowercase is following the standard, not attacking us.
      expect(bearerToken(`${scheme} abc`)).toBe('abc');
    },
  );

  it('tolerates repeated spaces between scheme and token', () => {
    expect(bearerToken('Bearer   abc')).toBe('abc');
  });

  it.each([
    ['undefined', undefined],
    ['an array', ['Bearer a', 'Bearer b'] as string[]],
    ['empty', ''],
    ['scheme only', 'Bearer'],
    ['token only', 'abc'],
    ['the wrong scheme', 'Basic abc'],
    ['a token containing a space', 'Bearer abc def'],
  ])('returns null for %s', (_case, header) => {
    expect(bearerToken(header)).toBeNull();
  });

  it('returns null for a duplicated header', () => {
    // Fastify surfaces a repeated header as an array. Picking one would let a
    // caller send a valid token beside an invalid one and choose the outcome.
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBeNull();
  });
});

/** A context whose handler carries the roles a route requires. */
function contextFor(
  request: AuthenticatedRequest,
  required?: readonly UserRole[],
): ExecutionContext {
  const handler = (): void => undefined;
  if (required !== undefined) Roles(...required)({}, 'handler', { value: handler });

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

let guard: AuthGuard;
let users: InMemoryUserDirectory;
let verifier: FakeSessionVerifier;

const SESSION = {
  clerkUserId: 'user_1',
  sessionId: 'sess_1',
  email: 'alice@example.com',
};

beforeEach(() => {
  users = new InMemoryUserDirectory();
  verifier = new FakeSessionVerifier().accept('good', SESSION);
  guard = new AuthGuard(
    new Reflector(),
    verifier,
    new IdentityService(users, new InMemoryWebhookLedger()),
    createRecordingLogger().logger,
  );
});

const authorised = (token: string): AuthenticatedRequest => ({
  headers: { authorization: `Bearer ${token}` },
});

describe('AuthGuard', () => {
  it('attaches the resolved account and session to the request', async () => {
    const request = authorised('good');
    await guard.canActivate(contextFor(request));

    expect(request.user).toMatchObject({ email: 'alice@example.com', role: 'USER' });
    expect(request.sessionId).toBe('sess_1');
  });

  it('rejects a request with no token', async () => {
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token the verifier refuses', async () => {
    await expect(
      guard.canActivate(contextFor(authorised('bad'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets any authenticated user through a route with no roles', async () => {
    // Absence of the decorator means "any authenticated user", never "anyone" —
    // the guard is applied to the controller, so the route is still guarded.
    await expect(guard.canActivate(contextFor(authorised('good')))).resolves.toBe(true);
  });

  it('allows a role the route requires', async () => {
    const admin = new InMemoryUserDirectory();
    const seeded: MirroredUser = {
      id: '00000000-0000-4000-8000-000000000001',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
      role: 'ADMIN',
      deletedAt: null,
      createdAt: new Date('2026-07-15T09:00:00.000Z'),
    };
    admin.seed(seeded);

    const adminGuard = new AuthGuard(
      new Reflector(),
      verifier,
      new IdentityService(admin, new InMemoryWebhookLedger()),
      createRecordingLogger().logger,
    );

    await expect(
      adminGuard.canActivate(contextFor(authorised('good'), ['ADMIN'])),
    ).resolves.toBe(true);
  });

  it('forbids a role the route requires but the account lacks', async () => {
    // 403 rather than 404: the caller is authenticated and already knows the
    // URL, so hiding it buys nothing and makes a permissions bug look like a
    // typo.
    await expect(
      guard.canActivate(contextFor(authorised('good'), ['ADMIN'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('authenticates before it authorises', async () => {
    // An unauthenticated request to an admin route must be 401, not 403 —
    // otherwise the response confirms the route exists to someone with no
    // session at all.
    await expect(
      guard.canActivate(contextFor({ headers: {} }, ['ADMIN'])),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a session whose account is deleted', async () => {
    const request = authorised('good');
    await guard.canActivate(contextFor(request));

    const user = request.user;
    if (user === undefined) throw new Error('expected the guard to attach a user');
    await users.update(user.id, { deletedAt: new Date() });

    await expect(
      guard.canActivate(contextFor(authorised('good'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthGuard — failures that are not authentication failures', () => {
  const exploding = (error: Error) => ({
    verify: () => Promise.reject(error),
  });

  it('does not turn an unexpected verifier fault into a 401', async () => {
    // A 401 says "your credentials are wrong". If the verifier dies because a
    // key file is unreadable, saying that sends the user to sign in again over
    // and over and hides an outage behind a login page.
    const boom = new TypeError('jwtKey is not a string');
    const broken = new AuthGuard(
      new Reflector(),
      exploding(boom),
      new IdentityService(users, new InMemoryWebhookLedger()),
      createRecordingLogger().logger,
    );

    await expect(broken.canActivate(contextFor(authorised('good')))).rejects.toBe(boom);
  });

  it('does not turn a database fault into a 401', async () => {
    const boom = new Error('connection terminated unexpectedly');
    const failing = {
      findByClerkUserId: () => Promise.reject(boom),
      findById: () => Promise.reject(boom),
      upsert: () => Promise.reject(boom),
      update: () => Promise.reject(boom),
    };

    const broken = new AuthGuard(
      new Reflector(),
      verifier,
      new IdentityService(failing, new InMemoryWebhookLedger()),
      createRecordingLogger().logger,
    );

    await expect(broken.canActivate(contextFor(authorised('good')))).rejects.toBe(boom);
  });
});

describe('currentUserFrom', () => {
  it('returns the account the guard attached', () => {
    const user: MirroredUser = {
      id: '00000000-0000-4000-8000-000000000009',
      clerkUserId: 'user_9',
      email: 'nine@example.com',
      role: 'USER',
      deletedAt: null,
      createdAt: new Date('2026-07-15T09:00:00.000Z'),
    };
    expect(currentUserFrom(contextFor({ headers: {}, user }))).toBe(user);
  });

  it('throws rather than returning undefined on an unguarded route', () => {
    // Returning undefined would leave a handler one `?.` away from treating an
    // unauthenticated request as an anonymous but permitted one, which is
    // precisely what Phase 1 exists to make impossible.
    expect(() => currentUserFrom(contextFor({ headers: {} }))).toThrow(/AuthGuard/);
  });
});
