import { describe, expect, it, vi } from 'vitest';
import { ClerkSessionVerifier } from './clerk-session-verifier.js';
import type { VerifiedClaims, VerifyTokenFn } from './clerk-session-verifier.js';
import { SessionVerificationError } from './session-verifier.js';

const JWT_KEY = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n';
const PARTIES = ['https://app.example'] as const;

const VALID: VerifiedClaims = {
  sub: 'user_123',
  sid: 'sess_456',
  email: 'alice@example.com',
};

function verifier(fn: VerifyTokenFn): ClerkSessionVerifier {
  return new ClerkSessionVerifier({
    verifyToken: fn,
    jwtKey: JWT_KEY,
    authorizedParties: PARTIES,
  });
}

const resolving =
  (claims: VerifiedClaims): VerifyTokenFn =>
  () =>
    Promise.resolve(claims);

describe('ClerkSessionVerifier', () => {
  it('returns the subject, session and email from a valid token', async () => {
    const session = await verifier(resolving(VALID)).verify('token');
    expect(session).toEqual({
      clerkUserId: 'user_123',
      sessionId: 'sess_456',
      email: 'alice@example.com',
    });
  });

  it('verifies against the configured key and authorised parties', async () => {
    // The azp check is what stops a token minted by another Clerk application
    // on the same instance being accepted here, so it must actually be passed
    // rather than merely configured.
    const verifyToken = vi.fn<VerifyTokenFn>(() => Promise.resolve(VALID));
    await verifier(verifyToken).verify('token');

    expect(verifyToken).toHaveBeenCalledWith('token', {
      jwtKey: JWT_KEY,
      authorizedParties: ['https://app.example'],
    });
  });

  it('copies the authorised parties rather than passing our frozen array', async () => {
    // The SDK's signature is mutable. Handing it our config array would let a
    // third party mutate configuration we treat as readonly everywhere else.
    const verifyToken = vi.fn<VerifyTokenFn>(() => Promise.resolve(VALID));
    await verifier(verifyToken).verify('token');

    const passed = verifyToken.mock.calls[0]?.[1].authorizedParties;
    expect(passed).toEqual([...PARTIES]);
    expect(passed).not.toBe(PARTIES);
  });

  it('rejects when the SDK rejects', async () => {
    // The root export throws rather than returning an error object. An adapter
    // written against the other overload would read `errors` as undefined and
    // treat every invalid token as valid.
    const boom = new Error('token expired');
    await expect(
      verifier(() => Promise.reject(boom)).verify('token'),
    ).rejects.toBeInstanceOf(SessionVerificationError);
  });

  it('carries the cause without putting it in the message', async () => {
    // Which check failed is a hint to whoever is probing the endpoint. It
    // belongs in the log line, which is why the cause survives.
    const boom = new Error('signature mismatch');

    await expect(
      verifier(() => Promise.reject(boom)).verify('t'),
    ).rejects.toMatchObject({
      message: 'session token is not valid',
      cause: boom,
    });
  });

  it.each([
    ['no subject', { sid: 'sess_1', email: 'a@b.com' }],
    ['an empty subject', { sub: '', sid: 'sess_1', email: 'a@b.com' }],
    ['no session id', { sub: 'user_1', email: 'a@b.com' }],
    ['an empty session id', { sub: 'user_1', sid: '', email: 'a@b.com' }],
  ])('rejects a token with %s', async (_case, claims) => {
    // Resolving without a subject would authenticate the request as nobody,
    // which is worse than rejecting a valid token.
    await expect(verifier(resolving(claims)).verify('token')).rejects.toBeInstanceOf(
      SessionVerificationError,
    );
  });

  it.each([
    ['missing', { sub: 'user_1', sid: 'sess_1' }],
    ['empty', { sub: 'user_1', sid: 'sess_1', email: '' }],
    ['not a string', { sub: 'user_1', sid: 'sess_1', email: { address: 'a@b.com' } }],
  ])('rejects a token whose email claim is %s', async (_case, claims) => {
    // The email is a custom claim, so a correctly-signed token from an instance
    // that lost the configuration arrives without it. The mirror cannot be
    // created without an address.
    await expect(verifier(resolving(claims)).verify('token')).rejects.toBeInstanceOf(
      SessionVerificationError,
    );
  });

  it('names the missing configuration when the email claim is absent', async () => {
    // This failure is a Clerk dashboard setting, not a code bug. The message
    // has to say so or it costs an afternoon.
    await expect(
      verifier(resolving({ sub: 'user_1', sid: 'sess_1' })).verify('token'),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('custom session claim'),
      }),
    });
  });
});
