/**
 * Turning a bearer token into an identity.
 *
 * The port is deliberately tiny: a token in, a Clerk user id out, an exception
 * otherwise. Everything Clerk-shaped — the JWT claims, the key handling, the
 * SDK's `{ data, errors }` return convention — stops at the adapter, so the
 * guard and the application service below it never learn which identity
 * provider we chose. Replacing Clerk means writing one new adapter, and ADR
 * 0015 records why that route has to stay open.
 */

/** What a valid session tells us. Claims we do not use are not surfaced. */
export interface VerifiedSession {
  /** Clerk's `user_…`, the `sub` claim. A reference, never our identity. */
  readonly clerkUserId: string;

  /** Clerk's `sess_…`, the `sid` claim. Recorded on audit events. */
  readonly sessionId: string;

  /**
   * The account's primary email, as a **custom session claim**.
   *
   * Not a default Clerk claim — the instance is configured to add it (see the
   * provisioning note in ADR 0015), and that configuration is load-bearing.
   * Without it the mirror could not be created on first request, because
   * `users.email` is NOT NULL and the alternative sources are both bad: asking
   * Clerk's Backend API would require the secret key we deliberately withheld,
   * and taking the address from the web app would mean trusting a caller to
   * name its own identity.
   *
   * Because it arrives inside a token Clerk signed, it is as trustworthy as the
   * subject beside it.
   */
  readonly email: string;

  /**
   * How long ago the session's **second** factor was verified, in minutes, or
   * null when it never was.
   *
   * From Clerk's `fva` claim — factor verification age, a pair of
   * `[first, second]` where `-1` means "not verified in this session". Only the
   * second element is surfaced, because the first is implied by holding a valid
   * token at all.
   *
   * **Null when the claim is absent, and that is deliberate.** An instance
   * without it produces correctly-signed tokens that carry no proof of a second
   * factor, and the only safe reading of "we cannot tell" is "not verified" —
   * so admin access is refused rather than granted (ADR 0021). The alternative,
   * treating an absent claim as satisfied, turns a missing configuration into
   * an open admin surface.
   *
   * An age rather than a boolean because BRD §8.13 wants step-up authentication
   * for high-risk actions, and "verified at some point in this session" is not
   * the same claim as "verified in the last few minutes".
   */
  readonly secondFactorAgeMinutes: number | null;
}

/**
 * Raised for every rejection, with no detail about which check failed.
 *
 * Expired, malformed, wrong signature, wrong authorised party and unknown
 * issuer are all one answer to the caller: not authenticated. Distinguishing
 * them in the response tells someone probing the endpoint which part of their
 * forgery to fix. The specifics belong in the log line, which is why the cause
 * is carried rather than discarded.
 */
export class SessionVerificationError extends Error {
  constructor(cause?: unknown) {
    super('session token is not valid');
    this.name = 'SessionVerificationError';
    this.cause = cause;
  }
}

export interface SessionVerifier {
  /** Resolves for a valid token, throws `SessionVerificationError` otherwise. */
  verify(token: string): Promise<VerifiedSession>;
}
