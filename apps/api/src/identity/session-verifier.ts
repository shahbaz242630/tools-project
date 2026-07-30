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
