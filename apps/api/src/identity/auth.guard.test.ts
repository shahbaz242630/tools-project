import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRecordingLogger } from '@platform/observability/testing';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  RecordingEraser,
  StubDataSource,
  StubProfileSummarySource,
  InMemoryAdminApprovalStore,
} from './testing/fakes.js';
import type { SessionInput } from './testing/fakes.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthGuard,
  MAX_SECOND_FACTOR_AGE_MINUTES,
  Roles,
  bearerToken,
  clientIpFrom,
} from './auth.guard.js';
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

/** The same session, with a second factor verified a few minutes ago. */
const MFA_SESSION = { ...SESSION, secondFactorAgeMinutes: 5 };

beforeEach(() => {
  users = new InMemoryUserDirectory();
  verifier = new FakeSessionVerifier().accept('good', SESSION);
  guard = new AuthGuard(
    new Reflector(),
    verifier,
    new IdentityService(
      users,
      new InMemoryWebhookLedger(),
      createAuditFakes().service,
      new RecordingEraser(),
      new StubDataSource(),
      new StubProfileSummarySource(),
      new InMemoryAdminApprovalStore(),
    ),
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
      deletionRequestedAt: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date('2026-07-15T09:00:00.000Z'),
    };
    admin.seed(seeded);

    const adminGuard = new AuthGuard(
      new Reflector(),
      // A second factor, granted explicitly. The fake defaults to none, so a
      // test that expects to reach an admin route has to say so — privilege is
      // never inherited from a fixture nobody reread.
      new FakeSessionVerifier().accept('good', MFA_SESSION),
      new IdentityService(
        admin,
        new InMemoryWebhookLedger(),
        createAuditFakes().service,
        new RecordingEraser(),
        new StubDataSource(),
        new StubProfileSummarySource(),
        new InMemoryAdminApprovalStore(),
      ),
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
      new IdentityService(
        users,
        new InMemoryWebhookLedger(),
        createAuditFakes().service,
        new RecordingEraser(),
        new StubDataSource(),
        new StubProfileSummarySource(),
        new InMemoryAdminApprovalStore(),
      ),
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
      countAdministrators: () => Promise.reject(boom),
      setSuspension: () => Promise.reject(boom),
    };

    const broken = new AuthGuard(
      new Reflector(),
      verifier,
      new IdentityService(
        failing,
        new InMemoryWebhookLedger(),
        createAuditFakes().service,
        new RecordingEraser(),
        new StubDataSource(),
        new StubProfileSummarySource(),
        new InMemoryAdminApprovalStore(),
      ),
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
      deletionRequestedAt: null,
      suspendedAt: null,
      suspensionReason: null,
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

describe('clientIpFrom', () => {
  const header = (value: string | string[] | undefined) => ({ 'x-client-ip': value });

  it('reads a forwarded IPv4 address', () => {
    expect(clientIpFrom(header('203.0.113.7'))).toBe('203.0.113.7');
  });

  it('reads a forwarded IPv6 address', () => {
    expect(clientIpFrom(header('2001:db8::1'))).toBe('2001:db8::1');
  });

  it('trims surrounding whitespace', () => {
    expect(clientIpFrom(header('  203.0.113.7  '))).toBe('203.0.113.7');
  });

  it('refuses a header sent twice, which Fastify joins into one string', () => {
    // The bug this test exists for. Two values arrive as "a,b" — a *string*,
    // so a `typeof` check passes it straight through. It would then reach an
    // `inet` column, throw, and take down the request it was auditing, because
    // audit writes are deliberately fail-closed.
    expect(clientIpFrom(header('203.0.113.7,198.51.100.4'))).toBeNull();
    expect(clientIpFrom(header('203.0.113.7, 198.51.100.4'))).toBeNull();
  });

  it('refuses an array, for the same reason', () => {
    expect(clientIpFrom(header(['203.0.113.7', '198.51.100.4']))).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not an address', 'localhost'],
    ['an address with a port', '203.0.113.7:54321'],
    ['a truncated address', '203.0.113'],
    ['an injection attempt', "203.0.113.7'; DROP TABLE audit_logs;--"],
  ])('refuses %s', (_label, value) => {
    // Recording null is the honest answer to "we cannot tell", and it keeps a
    // malformed header from becoming an outage.
    expect(clientIpFrom(header(value))).toBeNull();
  });
});

describe('the second factor an admin route requires', () => {
  function adminGuardFor(session: SessionInput): AuthGuard {
    const directory = new InMemoryUserDirectory();
    directory.seed({
      id: '00000000-0000-4000-8000-000000000001',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
      role: 'ADMIN',
      deletedAt: null,
      deletionRequestedAt: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date('2026-07-15T09:00:00.000Z'),
    });

    return new AuthGuard(
      new Reflector(),
      new FakeSessionVerifier().accept('good', session),
      new IdentityService(
        directory,
        new InMemoryWebhookLedger(),
        createAuditFakes().service,
        new RecordingEraser(),
        new StubDataSource(),
        new StubProfileSummarySource(),
        new InMemoryAdminApprovalStore(),
      ),
      createRecordingLogger().logger,
    );
  }

  const asAdmin = (guard: AuthGuard) =>
    guard.canActivate(contextFor(authorised('good'), ['ADMIN']));

  it('allows an admin who verified one recently', async () => {
    await expect(asAdmin(adminGuardFor(MFA_SESSION))).resolves.toBe(true);
  });

  it('allows one verified this instant', async () => {
    await expect(
      asAdmin(adminGuardFor({ ...SESSION, secondFactorAgeMinutes: 0 })),
    ).resolves.toBe(true);
  });

  it('refuses an admin whose session never verified one', async () => {
    // The ordinary case: an administrator signed in with a password alone.
    await expect(
      asAdmin(adminGuardFor({ ...SESSION, secondFactorAgeMinutes: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an absent claim rather than assuming it was satisfied', async () => {
    // The failure that matters. An instance provisioned without the claim emits
    // correctly-signed tokens carrying no proof of a second factor; treating
    // that as satisfied would turn a missing piece of configuration into an
    // open admin surface, silently (ADR 0021).
    await expect(asAdmin(adminGuardFor(SESSION))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses one verified too long ago', async () => {
    await expect(
      asAdmin(
        adminGuardFor({
          ...SESSION,
          secondFactorAgeMinutes: MAX_SECOND_FACTOR_AGE_MINUTES + 1,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows one verified exactly at the limit', async () => {
    await expect(
      asAdmin(
        adminGuardFor({
          ...SESSION,
          secondFactorAgeMinutes: MAX_SECOND_FACTOR_AGE_MINUTES,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('does not require one of an ordinary authenticated route', async () => {
    // MFA is required *of administrators*, not of everybody. A route with no
    // role restriction must not start demanding a second factor.
    const guard = adminGuardFor(SESSION);
    await expect(guard.canActivate(contextFor(authorised('good')))).resolves.toBe(true);
  });
});
