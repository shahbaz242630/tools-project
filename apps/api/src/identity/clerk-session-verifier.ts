import { SessionVerificationError } from './session-verifier.js';
import type { SessionVerifier, VerifiedSession } from './session-verifier.js';

/**
 * The slice of `@clerk/backend`'s `verifyToken` this adapter needs.
 *
 * Declared structurally rather than imported, for the same reason `PingClient`
 * is in `redis.check.ts`: the SDK stays in `main.ts`, the adapter stays
 * testable without it, and the shape we depend on is written down where a
 * breaking SDK change will fail the build against it.
 */
export interface VerifyTokenFn {
  (
    token: string,
    options: {
      jwtKey: string;
      /**
       * Mutable, matching the SDK. Our own config exposes this as readonly, so
       * the adapter copies rather than widening the shape upstream to suit a
       * third party's signature.
       */
      authorizedParties: string[];
    },
  ): Promise<VerifiedClaims>;
}

/**
 * The claims we read from a verified token.
 *
 * **`@clerk/backend` exports two different `verifyToken`s and they behave
 * differently.** The one under `tokens/verify` resolves to `{ data, errors }`
 * and never throws; the one re-exported from the package root — the documented
 * entry point, and the one used here — resolves to the payload directly and
 * *rejects* on failure. Writing the adapter against the wrong one produces code
 * that compiles, always finds `errors` undefined, and therefore treats every
 * rejected token as valid until the destructuring throws. Typechecking against
 * the real export is what caught it.
 *
 * Everything optional because a token from a misconfigured instance can be
 * correctly signed and still be missing the custom claim we depend on.
 */
export interface VerifiedClaims {
  fva?: unknown;
  readonly sub?: string;
  readonly sid?: string;
  /** Custom claim; see `VerifiedSession.email`. */
  readonly email?: unknown;
}

export interface ClerkSessionVerifierOptions {
  readonly verifyToken: VerifyTokenFn;

  /**
   * PEM public key. Its presence is what makes verification networkless — see
   * `CLERK_JWT_PUBLIC_KEY` in @platform/config for why that matters more than
   * it appears to.
   */
  readonly jwtKey: string;

  /** Accepted `azp` values. Never empty; the config schema enforces that. */
  readonly authorizedParties: readonly string[];
}

/**
 * Verifies Clerk session tokens locally.
 *
 * **No timeout, and that is a property rather than an omission.** BRD §5
 * requires every provider adapter to state its timeout and error strategy. This
 * one performs no I/O: with `jwtKey` supplied the SDK checks an RS256 signature
 * against a key already in memory, so there is no network call to bound and no
 * Clerk outage that can make an authenticated request hang. That is precisely
 * the property the public-key approach was chosen for, and it would be lost the
 * moment someone dropped `jwtKey` to let the SDK fetch JWKS instead.
 */
export class ClerkSessionVerifier implements SessionVerifier {
  constructor(private readonly options: ClerkSessionVerifierOptions) {}

  async verify(token: string): Promise<VerifiedSession> {
    let claims: VerifiedClaims;

    try {
      claims = await this.options.verifyToken(token, {
        jwtKey: this.options.jwtKey,
        authorizedParties: [...this.options.authorizedParties],
      });
    } catch (error) {
      // Expired, malformed, wrong signature, wrong authorised party — the SDK
      // rejects for all of them and the answer to the caller is the same one.
      throw new SessionVerificationError(error);
    }

    const { sub, sid, email, fva } = claims;

    // A result with neither errors nor a subject should be impossible. Treating
    // it as success would authenticate a request as nobody, which is the one
    // outcome worse than rejecting a valid token.
    if (
      typeof sub !== 'string' ||
      sub === '' ||
      typeof sid !== 'string' ||
      sid === ''
    ) {
      throw new SessionVerificationError(
        new Error('verified token carried no subject or session id'),
      );
    }

    // The email is a custom claim, so a correctly-signed token from a
    // misconfigured instance arrives without it. Rejecting is the only safe
    // answer: the mirror cannot be created without an address, and continuing
    // would either invent one or fail later against a NOT NULL constraint with
    // nothing pointing at the real cause.
    if (typeof email !== 'string' || email === '') {
      throw new SessionVerificationError(
        new Error(
          'verified token carried no email claim — the Clerk instance is missing ' +
            'the custom session claim this API depends on (see ADR 0015)',
        ),
      );
    }

    return {
      clerkUserId: sub,
      sessionId: sid,
      email,
      secondFactorAgeMinutes: secondFactorAge(fva),
    };
  }
}

/**
 * Read the second factor's age out of Clerk's `fva` claim.
 *
 * The claim is a pair — `[firstFactorAge, secondFactorAge]` in minutes, with
 * `-1` meaning "not verified in this session". Only the second matters here:
 * the first is implied by holding a valid token at all.
 *
 * **Everything unexpected reads as null, which the guard treats as "no second
 * factor".** An instance that does not emit the claim, a claim of the wrong
 * shape, a negative age — all of them mean the same thing, that we cannot prove
 * a second factor was used, and the only safe reading of that is to refuse
 * (ADR 0021). Guessing "probably fine" here would turn a missing configuration
 * into an open admin surface.
 */
export function secondFactorAge(fva: unknown): number | null {
  if (!Array.isArray(fva)) return null;

  const second: unknown = fva[1];
  if (typeof second !== 'number' || !Number.isFinite(second)) return null;

  // -1 is Clerk's "not verified". Any other negative value is nonsense, and
  // both are answered the same way.
  return second < 0 ? null : second;
}
