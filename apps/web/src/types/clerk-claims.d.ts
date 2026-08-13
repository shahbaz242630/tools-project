/**
 * The custom session claims this Clerk instance is configured to mint.
 *
 * **This is the only place the claim contract is written down in code**, and it
 * exists because the configuration behind it is dashboard state that lives
 * outside version control (ADR 0015). An instance missing the claim produces
 * correctly-signed tokens that carry no address, and the failure surfaces
 * nowhere near the cause.
 *
 * `email` is added with:
 *
 *     clerk config patch --json '{"session":{"claims":{"email":"{{user.primary_email_address}}"}}}'
 *
 * Optional rather than required, deliberately: the type describes what a token
 * *may* carry, and code that reads it has to handle its absence rather than
 * trusting a declaration to make it true. The API treats a missing claim as a
 * hard configuration error; the web app only ever uses it for an avatar letter,
 * so here it degrades to a fallback.
 */
declare global {
  interface CustomJwtSessionClaims {
    email?: string;
  }
}

export {};
