/**
 * Prove a second factor from a Cloudflare Access assertion.
 *
 * **The proof here is structural, and that is the whole design.** Clerk admits
 * everyone and lets us inspect *how* they authenticated through the `fva`
 * claim. Access works the other way round: it refuses to mint a token at all
 * unless its policy passed. So a valid assertion for our application audience
 * *is* proof that whatever the policy required — a TOTP code, a security key —
 * was presented. The check lives in the Access policy; this file's job is to
 * establish that the assertion is genuinely Cloudflare's and genuinely ours.
 *
 * That is why the research mattered: **the Access JWT carries no `amr` claim
 * and no "factor verified at" timestamp**, so the `fva` pattern cannot be
 * ported. `iat` is the only freshness signal in the token, and it is only
 * meaningful because the *global* session duration is bounded to 12 hours in
 * the Cloudflare dashboard — an application token silently auto-renews from a
 * still-valid global session, so an unbounded global session would mint fresh
 * `iat` values forever without anybody re-presenting anything. See ADR 0053.
 *
 * **This adapter performs I/O, and `ClerkSessionVerifier`'s justification for
 * declaring no timeout cannot be copied.** Cloudflare rotates the signing keys
 * every six weeks and forbids hard-coding them, so the key set is fetched.
 * `createRemoteJWKSet` caches it and refetches only on an unknown `kid`, so the
 * steady state is networkless — but the first request after a rotation is not,
 * and BRD §5 requires an explicit timeout and error strategy for that.
 */

import { Time } from '@platform/core';
import { ACCESS_ASSERTION_HEADER } from '@platform/contracts';
import type { Logger } from '@platform/observability';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AdminSecondFactor, SecondFactorEvidence } from './admin-second-factor.js';

/**
 * How long to wait for Cloudflare's key set.
 *
 * Short on purpose. It is only reached on a cold start or a key rotation, it
 * sits inside an authentication path, and a timeout here is not an outage —
 * it is one refused admin request that fails closed and logs why. Waiting
 * longer would trade a clear refusal for a hung request.
 */
const JWKS_TIMEOUT_MS = 3_000;

/**
 * Tolerance for clock drift between us and Cloudflare, in seconds.
 *
 * `jose` applies it to `exp` and `nbf`. Small: the box runs NTP, and a generous
 * tolerance on a security assertion buys an attacker time rather than buying us
 * reliability.
 */
const CLOCK_TOLERANCE_SECONDS = 5;

export interface CloudflareAccessSecondFactorOptions {
  /** `https://<team>.cloudflareaccess.com` — the issuer *and* the JWKS host. */
  readonly teamDomain: string;
  /** The Application Audience tag of the Access application guarding `/admin`. */
  readonly audience: string;
  readonly logger: Logger;
  /** Injected only so a test can verify without reaching Cloudflare. */
  readonly verify?: AccessTokenVerifier;
  /**
   * The clock, injected the way `AvailabilityService` injects it.
   *
   * `Time.nowUtc` rather than a bare `Date`, which this project's lint rule
   * refuses outright so that timezone handling stays explicit — and taking it
   * as a parameter means a test states the instant it is reasoning about
   * instead of reaching for fake timers.
   */
  readonly now?: () => Date;
}

/**
 * The verification step, as a function.
 *
 * Structural rather than a `jose` type import, for the reason
 * `ClerkSessionVerifier` gives: an SDK's own types in our signatures make the
 * SDK impossible to substitute in a test without importing it, which is what
 * `no-provider-sdk-outside-adapter` exists to prevent.
 */
export type AccessTokenVerifier = (token: string) => Promise<Record<string, unknown>>;

export class CloudflareAccessSecondFactor implements AdminSecondFactor {
  readonly name = 'cloudflare-access';

  /** It proves a real factor — the Access policy is what requires one. */
  readonly bypassesSecondFactor = false;

  private readonly logger: Logger;
  private readonly verify: AccessTokenVerifier;
  private readonly now: () => Date;

  constructor(options: CloudflareAccessSecondFactorOptions) {
    this.logger = options.logger;
    this.verify = options.verify ?? defaultVerifier(options);
    this.now = options.now ?? Time.nowUtc;
  }

  async ageMinutes(evidence: SecondFactorEvidence): Promise<number | null> {
    const token = assertionFrom(evidence.headers[ACCESS_ASSERTION_HEADER]);
    if (token === null) return null;

    let claims: Record<string, unknown>;
    try {
      claims = await this.verify(token);
    } catch (error) {
      // Unproven, not an error. A forged token, an expired one, a rotation we
      // could not fetch through and a Cloudflare outage all land here, and all
      // of them mean the same thing to the caller: this did not prove a second
      // factor. Which one it was belongs in the log, never in the response.
      this.logger.warn('could not verify a Cloudflare Access assertion', { error });
      return null;
    }

    if (!isHumanIdentity(claims)) {
      // **A service token must never satisfy an administrator's second
      // factor.** Access mints assertions for machine callers too, signed by
      // the same keys and carrying the same audience, so signature and
      // audience alone do not distinguish them. Refused on all three
      // discriminators rather than the tidiest one, because a future Cloudflare
      // change to any single field should not silently admit machines.
      this.logger.warn('refused a non-human Cloudflare Access assertion', {
        // The Client ID names which service token, and is not a secret. No
        // email is logged: a refusal does not need to record who was refused.
        commonName:
          typeof claims['common_name'] === 'string' ? claims['common_name'] : null,
      });
      return null;
    }

    return ageInMinutes(claims['iat'], this.now(), this.logger);
  }
}

/**
 * Read the assertion out of the header, or null.
 *
 * **A repeated header arrives as one comma-separated string in Fastify**, not
 * an array — the trap `clientIpFrom` documents. Two values means something sits
 * between us and the web app, and picking one would be guessing; both are
 * refused. A JWT contains no comma, so the check is exact rather than heuristic.
 */
function assertionFrom(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;

  const token = header.trim();
  if (token === '' || token.includes(',')) return null;

  return token;
}

/**
 * Whether these claims describe a person rather than a machine.
 *
 * A human assertion carries a non-empty `email` and `sub` and no `common_name`;
 * a service token carries `common_name` (the Client ID), an empty `sub` and no
 * `email`. All three are checked.
 */
function isHumanIdentity(claims: Record<string, unknown>): boolean {
  if (claims['common_name'] !== undefined && claims['common_name'] !== '') return false;
  if (typeof claims['email'] !== 'string' || claims['email'] === '') return false;
  if (typeof claims['sub'] !== 'string' || claims['sub'] === '') return false;

  return true;
}

/**
 * Minutes since the assertion was issued, or null if it cannot be read.
 *
 * Returns null rather than a negative number for a token issued in the future:
 * the chain refuses a negative age anyway, but "we cannot tell" is the honest
 * answer to a clock that disagrees with ours, and it is the answer that reads
 * correctly in a log.
 */
function ageInMinutes(iat: unknown, now: Date, logger: Logger): number | null {
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    logger.warn('a Cloudflare Access assertion carried no usable issued-at claim');
    return null;
  }

  const seconds = Math.floor(now.getTime() / 1000) - iat;
  if (seconds < 0) {
    logger.warn('a Cloudflare Access assertion was issued in the future', { seconds });
    return null;
  }

  return Math.floor(seconds / 60);
}

/**
 * The real verifier.
 *
 * Built once per adapter, never per request: `createRemoteJWKSet` holds the
 * cache, so constructing it per call would refetch Cloudflare's keys on every
 * admin request and turn a cached lookup into a network round trip inside an
 * authentication path.
 */
function defaultVerifier(
  options: CloudflareAccessSecondFactorOptions,
): AccessTokenVerifier {
  const keys = createRemoteJWKSet(
    new URL(`${options.teamDomain}/cdn-cgi/access/certs`),
    {
      timeoutDuration: JWKS_TIMEOUT_MS,
    },
  );

  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: options.teamDomain,
      audience: options.audience,
      // **Pinned, never taken from the token's own header.** Accepting the
      // algorithm a token declares is how `alg: none` and HMAC-with-the-public-key
      // forgeries work. `jose` enforces `exp` and `nbf` itself.
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });

    return payload as Record<string, unknown>;
  };
}
